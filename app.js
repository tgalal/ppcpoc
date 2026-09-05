// P2P Contacts — the recipient's page. Plain JavaScript, no build step,
// following tailcat's own web app. The Go side (main_js.go, vendored)
// exposes the global tailcatDial.
//
// The whole recipient experience lives here: land on this page with a
// "tc..." token in the fragment, dial the sender's phone over Tailcat,
// read a vCard, and show it as something a person would want to look at.

// The token never leaves the client: it lives in the fragment, which
// browsers do not send to the server. See docs/overview.md.
//
// Two shapes land here. url-only mode's fragment is the bare tailcat
// address. Hybrid mode's is "<addr>&v=<base64url(vcard)>" -- tailcat
// addresses are base64url themselves (see docs/asfp-results.md), so "&"
// and "=" can't appear in addr and are safe, unambiguous delimiters.
function parseFragment(rawHash) {
  const decoded = decodeURIComponent(rawHash);
  const split = decoded.indexOf("&v=");
  if (split < 0) return { addr: decoded, embeddedVCard: null };

  const addr = decoded.slice(0, split);
  const encoded = decoded.slice(split + 3);
  try {
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return { addr, embeddedVCard: new TextDecoder().decode(bytes) };
  } catch {
    // A malformed v= is not fatal to the url-only half of hybrid: fall
    // back to dialling as if this were a plain url-only link.
    return { addr, embeddedVCard: null };
  }
}

const { addr, embeddedVCard } = parseFragment(location.hash.slice(1));

const params = new URLSearchParams(location.search);
const verbose = params.has("verbose");

// Tailcat's public DERP map, which answers cross-origin fetches with
// access-control-allow-origin: *. A same-origin derpmap.json wins if this
// host serves one, which is how we would drop the third-party dependency.
const canonicalDERPMapURL = "https://tailcat.dev/derpmap.json";

// The port the sender's OnTCP handler answers on; 1 is the tailcat CLI's
// default and what transport/tcbind serves.
const PORT = 1;

// The sender's listener is ephemeral and the address dies with it, so a
// dial that hangs means "nobody is there" far more often than "slow".
// Bounded so that turns into an answer instead of a spinner forever.
const DIAL_TIMEOUT_MS = 45_000;

const $ = (id) => document.getElementById(id);
const t0 = performance.now();
const marks = [];

// pocResult is the structured form of what the page shows, for the
// headless harness in web/e2e and for scripted measurement runs. The
// shape is load-bearing -- web/e2e reads these exact fields. `online`
// flips true only once a hybrid or url-only page has rendered the vCard
// fetched live from the phone, distinct from `done`, which flips true as
// soon as hybrid mode has something -- even just the offline URL data --
// on screen. A consumer that wants the fully-loaded snapshot rather than
// racing `done`'s timing should wait on `online` too.
window.pocResult = { done: false, error: null, bytes: 0, vcard: null, contact: null, online: false, marks };

// ---------------------------------------------------------------- timings

function mark(name) {
  const at = performance.now() - t0;
  const prev = marks.length ? marks[marks.length - 1].at : 0;
  marks.push({ name, at, delta: at - prev });
  if (verbose) renderTimings();
}

function renderTimings() {
  const table = $("timings");
  table.hidden = false;
  table.tBodies[0].replaceChildren(...marks.map(({ name, at, delta }) => {
    const tr = document.createElement("tr");
    for (const [text, cls] of [[name, ""], [`+${delta.toFixed(0)} ms`, "n"], [`${at.toFixed(0)} ms`, "n"]]) {
      const td = document.createElement("td");
      td.textContent = text;
      td.className = cls;
      tr.append(td);
    }
    return tr;
  }));
}

// ------------------------------------------------------------------ states

/** Ends the page on an honest explanation rather than a spinner. */
function fail(title, detail) {
  window.pocResult.error = `${title} ${detail}`.trim();
  window.pocResult.done = true;
  $("loading").hidden = true;
  $("profile").hidden = true;
  $("error").hidden = false;
  $("error-title").textContent = title;
  $("error-detail").textContent = detail;
  throw new PageError(title);
}

class PageError extends Error {}

// -------------------------------------------------------------- vCard parse

/**
 * Parses vCard 2.1, 3.0 and 4.0 into one renderable contact.
 *
 * All three dialects are in play and none of them agree, which is not
 * hypothetical: Android's contacts provider exports 2.1, our own sample payload
 * is 4.0, and iOS prefers 3.0. 2.1 is the awkward one -- it puts type
 * parameters in without a TYPE= key (TEL;CELL;PREF:) and encodes non-ASCII as
 * quoted-printable rather than UTF-8.
 *
 * A payload may also hold *several* vCards. Android emits one per raw contact
 * behind an aggregated one, so a single person arrives as three overlapping
 * cards -- name only, phone only, everything. They are merged: one human, one
 * card. Rendering the first would silently drop half their details, and saving
 * all three would create three entries in the recipient's address book.
 */
function parseVCard(text) {
  const blocks = splitCards(normalise(text));
  const cards = blocks.map(parseProps).filter((props) => props.length);
  if (!cards.length) return null;
  return mergeCards(cards.map(buildCard));
}

/**
 * Like parseVCard, but never null. A hybrid link's offline vCard is
 * flexible by design -- it may carry just a name, a few fields, or nothing
 * at all -- and treating "nothing parsed" as a failure would defeat the
 * whole point of rendering it immediately. The blank shape is exactly
 * what mergeCards would produce from zero cards, so it renders the same
 * way an empty-but-present card would (initials avatar, no rows).
 */
function parseVCardOrBlank(text) {
  return parseVCard(text) || {
    fn: "",
    n: { family: "", given: "", middle: "", prefix: "", suffix: "" },
    org: [], title: "", bday: "", note: "", photo: null,
    tels: [], emails: [], urls: [], adrs: [], cards: 0,
  };
}

/**
 * Joins continuation lines, of which there are two unrelated kinds.
 *
 * vCard folding is a newline followed by a space, and 2.1 folds base64 photos
 * across dozens of them. Quoted-printable soft breaks are a trailing "=" with
 * the continuation starting at column zero. Handling only the first truncates
 * every accented name and multi-line note; handling the second indiscriminately
 * eats the line after a base64 photo, because "=" is also base64 padding. So
 * the soft break is joined only on lines that say they are quoted-printable.
 */
function normalise(text) {
  const unfolded = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "");

  const out = [];
  const lines = unfolded.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/ENCODING=QUOTED-PRINTABLE/i.test(line)) {
      while (line.endsWith("=") && i + 1 < lines.length) {
        line = line.slice(0, -1) + lines[++i];
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function splitCards(text) {
  const blocks = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (/^BEGIN:VCARD/i.test(line)) { cur = []; continue; }
    if (/^END:VCARD/i.test(line)) { if (cur) blocks.push(cur); cur = null; continue; }
    if (cur) cur.push(line);
  }
  // A payload with no BEGIN at all is still worth trying to read.
  if (!blocks.length && text.trim()) blocks.push(text.split("\n"));
  return blocks;
}

function parseProps(lines) {
  const props = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;

    // Property names never contain a colon, but values routinely do (URLs,
    // data: URIs), so only the first one separates.
    const head = line.slice(0, colon);
    let value = line.slice(colon + 1);

    const parts = head.split(";");
    // iOS and others prefix grouped properties: "item1.TEL".
    const name = parts[0].replace(/^[A-Za-z0-9-]+\./, "").toUpperCase();
    if (name === "VERSION") continue;

    const params = {};
    const flags = [];
    for (const prm of parts.slice(1)) {
      const eq = prm.indexOf("=");
      if (eq < 0) {
        flags.push(prm.toUpperCase());          // 2.1 style: TEL;CELL;PREF
      } else {
        const key = prm.slice(0, eq).toUpperCase();
        const val = prm.slice(eq + 1).replace(/^"|"$/g, "");
        (params[key] ||= []).push(...val.split(","));
      }
    }
    const types = [...(params.TYPE || []), ...flags].map((t) => t.toUpperCase());
    const encoding = (params.ENCODING || [])[0]?.toUpperCase() || "";

    if (encoding === "QUOTED-PRINTABLE") value = decodeQuotedPrintable(value);

    props.push({ name, value, params, types, encoding });
  }
  return props;
}

/** vCard 2.1 encodes anything non-ASCII this way, so names arrive mangled without it. */
function decodeQuotedPrintable(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(s.charCodeAt(i) & 0xff);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return s;
  }
}

/** Undoes the backslash escaping 3.0 and 4.0 apply to text values. */
function unescapeText(s) {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

/** Splits a structured value (N, ADR, ORG) on unescaped semicolons. */
function splitStructured(s) {
  const out = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; }
    else if (s[i] === ";") { out.push(cur); cur = ""; }
    else cur += s[i];
  }
  out.push(cur);
  return out.map(unescapeText);
}

/** Human label for a phone/email/url, from whichever dialect supplied it. */
function labelFor(types, fallback) {
  const profileTypes = {
    WEBSITE: "Website",
    GITHUB: "GitHub",
    LINKEDIN: "LinkedIn",
    INSTAGRAM: "Instagram",
    WHATSAPP: "WhatsApp",
  };
  const profileType = types.find((t) => profileTypes[t]);
  if (profileType) return profileTypes[profileType];
  const known = ["MOBILE", "CELL", "HOME", "WORK", "MAIN", "FAX", "PAGER", "IPHONE", "OTHER"];
  const hit = types.find((t) => known.includes(t));
  if (!hit) return fallback;
  if (hit === "CELL" || hit === "IPHONE" || hit === "MOBILE") return "Mobile";
  return hit.charAt(0) + hit.slice(1).toLowerCase();
}

/** One parsed vCard block, in the shape the renderer and the writer both want. */
function buildCard(props) {
  const first = (n) => props.find((p) => p.name === n);
  const all = (n) => props.filter((p) => p.name === n);

  const n = first("N") ? splitStructured(first("N").value) : [];
  const fn = unescapeText(first("FN")?.value || "").trim() ||
    [n[3], n[1], n[2], n[0], n[4]].filter(Boolean).join(" ").trim();

  return {
    fn,
    n: { family: n[0] || "", given: n[1] || "", middle: n[2] || "", prefix: n[3] || "", suffix: n[4] || "" },
    org: first("ORG") ? splitStructured(first("ORG").value).filter(Boolean) : [],
    title: unescapeText(first("TITLE")?.value || "").trim(),
    bday: first("BDAY")?.value?.trim() || "",
    note: unescapeText(first("NOTE")?.value || "").trim(),
    photo: parsePhoto(first("PHOTO")),
    tels: all("TEL").map((p) => ({ value: unescapeText(p.value).trim(), types: p.types })).filter((x) => x.value),
    emails: all("EMAIL").map((p) => ({ value: unescapeText(p.value).trim(), types: p.types })).filter((x) => x.value),
    urls: all("URL").map((p) => ({ value: unescapeText(p.value).trim(), types: p.types })).filter((x) => x.value),
    adrs: all("ADR").map((p) => ({ parts: splitStructured(p.value), types: p.types }))
      .filter((a) => a.parts.some(Boolean)),
    count: props.length,
  };
}

/**
 * Merges the raw contacts Android splits a person into.
 *
 * Scalars take the first non-empty value, richest card first, so the card that
 * actually carries the person's details wins over the stub that carries only a
 * name. Lists are concatenated and de-duplicated on a normalised form -- the
 * same number written two ways is the common case, and showing it twice is
 * exactly the sort of thing that makes a page look broken.
 */
function mergeCards(cards) {
  const ordered = [...cards].sort((a, b) => b.count - a.count);
  const pick = (key) => ordered.find((c) => c[key])?.[key] || "";

  const dedupe = (lists, keyOf) => {
    const seen = new Map();
    for (const item of lists.flat()) {
      const key = keyOf(item.value);
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, item);
      else if (item.types.length && !seen.get(key).types.length) seen.set(key, item);
    }
    return [...seen.values()];
  };

  const nCard = ordered.find((c) => c.n.family || c.n.given);
  return {
    fn: pick("fn"),
    n: nCard ? nCard.n : { family: "", given: "", middle: "", prefix: "", suffix: "" },
    org: ordered.find((c) => c.org.length)?.org || [],
    title: pick("title"),
    bday: pick("bday"),
    note: pick("note"),
    photo: ordered.find((c) => c.photo)?.photo || null,
    tels: dedupe(ordered.map((c) => c.tels), (v) => v.replace(/[^\d+]/g, "").replace(/^\+?0+/, "")),
    emails: dedupe(ordered.map((c) => c.emails), (v) => v.toLowerCase()),
    urls: dedupe(ordered.map((c) => c.urls), (v) => v.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "")),
    adrs: dedupe(ordered.map((c) => c.adrs.map((a) => ({ ...a, value: a.parts.join(";") }))),
                 (v) => v.toLowerCase().replace(/\s+/g, " ")),
    cards: cards.length,
  };
}

/**
 * Normalises however this vCard carried a photo.
 *
 * 2.1 says PHOTO;ENCODING=BASE64;JPEG, 3.0 says ENCODING=b;TYPE=JPEG, and 4.0
 * hands over a data: URI already. A remote URI is dropped deliberately: fetching
 * it would be a request to a third party from a page whose whole promise is that
 * the contact came straight off the sender's phone.
 */
function parsePhoto(prop) {
  if (!prop) return null;
  const raw = prop.value.trim();
  if (!raw) return null;

  if (raw.startsWith("data:")) {
    const m = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    return m ? { mime: m[1].toLowerCase(), b64: m[2].replace(/\s+/g, "") } : null;
  }
  if (/^https?:/i.test(raw)) return null;

  const b64 = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length < 32) return null;
  const type = (prop.types.find((t) => ["JPEG", "JPG", "PNG", "GIF", "WEBP"].includes(t)) || "JPEG")
    .toLowerCase().replace(/^jpg$/, "jpeg");
  return { mime: `image/${type}`, b64 };
}

/** The rows the profile shows, in the order a person scans them. */
function displayRows(c) {
  const rows = [];
  for (const t of c.tels) {
    rows.push({ value: t.value, label: labelFor(t.types, "Phone"), icon: "i-phone",
                href: `tel:${t.value.replace(/[^\d+*#]/g, "")}` });
  }
  for (const e of c.emails) {
    rows.push({ value: e.value, label: labelFor(e.types, "Email"), icon: "i-mail",
                href: `mailto:${e.value}` });
  }
  for (const u of c.urls) {
    rows.push({
      value: prettyURL(u.value),
      label: labelFor(u.types, "Website"), icon: "i-link", external: true,
      href: /^[a-z][a-z0-9+.-]*:/i.test(u.value) ? u.value : `https://${u.value}`,
    });
  }
  for (const a of c.adrs) {
    const value = [a.parts[2], a.parts[3], a.parts[4], a.parts[5], a.parts[6]].filter(Boolean).join(", ");
    if (!value) continue;
    rows.push({ value, label: labelFor(a.types, "Address"), icon: "i-pin", external: true,
                href: `https://maps.google.com/?q=${encodeURIComponent(value)}` });
  }
  if (c.org.length) rows.push({ value: c.org.join(" · "), label: "Organisation", icon: "i-org" });
  if (c.bday) rows.push({ value: formatDate(c.bday), label: "Birthday", icon: "i-cake" });
  if (c.note) rows.push({ value: c.note, label: "Note", icon: "i-note", cls: "note" });
  return rows;
}

/**
 * Shortens a URL for display without lying about where it goes.
 *
 * The host is the part a person reads to decide whether to tap; a 40-character
 * opaque profile id is not. The href keeps the whole thing.
 */
function prettyURL(raw) {
  const bare = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (bare.length <= 44) return bare;
  const slash = bare.indexOf("/");
  const host = slash < 0 ? bare : bare.slice(0, slash);
  const rest = slash < 0 ? "" : bare.slice(slash);
  if (host.length + 12 >= 44) return bare.slice(0, 43) + "…";
  return host + rest.slice(0, 44 - host.length - 1) + "…";
}

function formatDate(raw) {
  const m = raw.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m) return raw;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d)) return raw;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

// ------------------------------------------------------------- vCard write

/**
 * Writes one clean vCard 3.0 for the recipient to save.
 *
 * Not a pass-through of what arrived, for two reasons. Android sends several
 * cards for one person, and saving that verbatim puts three of them in the
 * recipient's address book. And it sends 2.1, which is from 1996 -- 3.0 is the
 * dialect both iOS and Android read without complaint.
 *
 * The cost is fidelity: a property this page does not model is not written out.
 * That is the right trade for a contact card, where the fields are well known
 * and a duplicate-riddled address book is the failure people actually notice.
 */
function toVCard3(c) {
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\;")
    .replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];

  lines.push(`N:${[c.n.family, c.n.given, c.n.middle, c.n.prefix, c.n.suffix].map(esc).join(";")}`);
  if (c.fn) lines.push(`FN:${esc(c.fn)}`);
  if (c.org.length) lines.push(`ORG:${c.org.map(esc).join(";")}`);
  if (c.title) lines.push(`TITLE:${esc(c.title)}`);

  const typeParam = (types, fallback) => {
    const keep = types.filter((t) => ["HOME", "WORK", "CELL", "FAX", "PAGER", "MAIN", "PREF"].includes(t));
    return (keep.length ? keep : [fallback]).join(",");
  };
  for (const t of c.tels) lines.push(`TEL;TYPE=${typeParam(t.types, "VOICE")}:${esc(t.value)}`);
  for (const e of c.emails) {
    // INTERNET is not decoration: some importers key off it to decide the
    // field is an address at all, so it stays even when a HOME/WORK is known.
    const t = [...new Set(["INTERNET", ...typeParam(e.types, "INTERNET").split(",")])].join(",");
    lines.push(`EMAIL;TYPE=${t}:${esc(e.value)}`);
  }
  for (const u of c.urls) {
    const keep = u.types.filter((t) => ["WEBSITE", "GITHUB", "LINKEDIN", "INSTAGRAM", "WHATSAPP"].includes(t));
    lines.push(`URL${keep.length ? `;TYPE=${keep.join(",")}` : ""}:${esc(u.value)}`);
  }
  for (const a of c.adrs) {
    const p = [...a.parts];
    while (p.length < 7) p.push("");
    lines.push(`ADR;TYPE=${typeParam(a.types, "HOME")}:${p.slice(0, 7).map(esc).join(";")}`);
  }
  if (c.bday) lines.push(`BDAY:${c.bday}`);
  if (c.note) lines.push(`NOTE:${esc(c.note)}`);
  if (c.photo) {
    const sub = c.photo.mime.split("/")[1].toUpperCase();
    lines.push(`PHOTO;ENCODING=b;TYPE=${sub}:${c.photo.b64}`);
  }
  lines.push("END:VCARD");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** RFC 2426 folding: 75 octets, continuations begin with a space. */
function foldLine(line) {
  if (line.length <= 75) return line;
  const out = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) out.push(" " + line.slice(i, i + 74));
  return out.join("\r\n");
}

// -------------------------------------------------------------------- render

function initials(name) {
  const words = name.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (!words.length) return "?";
  const take = (w) => [...w].find((c) => /\p{L}/u.test(c)) || "";
  return (take(words[0]) + (words.length > 1 ? take(words[words.length - 1]) : "")).toUpperCase();
}

/** A stable colour per person, so the same contact always looks the same. */
function hueFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

function renderContact(contact) {
  document.title = contact.fn || "Contact";

  const avatar = $("avatar");
  if (contact.photo) {
    const img = new Image();
    img.alt = contact.fn;
    img.src = `data:${contact.photo.mime};base64,${contact.photo.b64}`;
    // A corrupt or truncated base64 photo must degrade to initials, not to a
    // broken-image icon in the middle of someone's face.
    img.onerror = () => paintInitials(avatar, contact.fn);
    avatar.replaceChildren(img);
  } else {
    paintInitials(avatar, contact.fn);
  }

  $("fn").textContent = contact.fn || "Contact";
  if (contact.title) {
    $("role").textContent = contact.title;
    $("role").hidden = false;
  } else {
    $("role").hidden = true;
  }

  $("rows").replaceChildren(...displayRows(contact).map((row) => {
    const li = document.createElement("li");
    const el = document.createElement(row.href ? "a" : "div");
    el.className = row.cls ? `row ${row.cls}` : "row";
    if (row.href) {
      el.href = row.href;
      if (row.external) { el.target = "_blank"; el.rel = "noopener noreferrer"; }
    }

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "glyph");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${row.icon}`);
    svg.append(use);

    const text = document.createElement("div");
    text.className = "text";
    const value = document.createElement("div");
    value.className = "value";
    value.textContent = row.value;
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = row.label;
    text.append(value, label);

    el.append(svg, text);
    li.append(el);
    return li;
  }));

  $("loading").hidden = true;
  $("profile").hidden = false;
}

function paintInitials(avatar, name) {
  const hue = hueFor(name || "?");
  avatar.style.background = `linear-gradient(135deg, hsl(${hue} 62% 55%), hsl(${(hue + 40) % 360} 62% 45%))`;
  avatar.textContent = initials(name || "?");
}

// ------------------------------------------------------------------ saving

/**
 * Builds the vCard as a downloadable blob and the filename to save it as.
 * Used directly by the download fallback, and to name the <a href> that
 * worker mode's service worker intercepts (see wireSaveButton).
 */
export function buildVCardFile(contact) {
  const filename = `${(contact.fn || "contact").replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "contact"}.vcf`;
  const blob = new Blob([new TextEncoder().encode(toVCard3(contact))], { type: "text/vcard" });
  return { blob, filename };
}

/**
 * Registers the .vcf-handoff service worker (tarek/p2pcontacts#68) and
 * resolves to whether it's actually usable -- false for any browser or
 * context that can't run one (no serviceWorker support, an insecure
 * context, an in-app webview), in which case the save button falls back to
 * an ordinary blob download. Cached so every caller shares one attempt.
 */
let swReadyPromise = null;
function ensureServiceWorker() {
  if (!swReadyPromise) {
    swReadyPromise = (async () => {
      if (!self.isSecureContext || !("serviceWorker" in navigator)) return false;
      try {
        await navigator.serviceWorker.register("sw.js");
        await navigator.serviceWorker.ready;
        return true;
      } catch {
        return false;
      }
    })();
  }
  return swReadyPromise;
}

/**
 * Sets the save button's label/hint/href for whichever handoff mode is in
 * play. Unlike the old share-vs-download choice, the mode itself never
 * changes once picked (it depends only on service-worker support, not on
 * the contact's data), so this only needs re-running when the filename
 * changes as richer data replaces the offline placeholder.
 */
function setSavePresentation(mode, filename) {
  const button = $("save");
  const hint = $("save-hint");
  button.dataset.handoff = mode;
  if (mode === "worker") {
    button.href = encodeURI(filename);
    button.querySelector(".label").textContent = "Save to contacts";
    hint.textContent = "Opens your device's Add Contact screen.";
  } else {
    button.href = "#";
    button.querySelector(".label").textContent = "Download contact";
    hint.textContent = "Downloads a .vcf file. Open it from Downloads to add it to Contacts.";
  }
  hint.hidden = false;
}

function downloadViaLink(blob, filename, hint) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  hint.textContent = `Downloaded ${filename}. Open it from Downloads to add it to Contacts.`;
  hint.hidden = false;
}

function setLoading(button, loading) {
  button.setAttribute("aria-busy", loading ? "true" : "false");
}

/**
 * Wires the "Save to contacts" / "Download contact" button against
 * `offlineContact` immediately, upgrading to whatever `onlinePromise`
 * eventually resolves with (or staying on the offline contact if it
 * rejects).
 *
 * awaitBestContact is the one place the "wait up to 5s for the richer
 * online vCard, else use what's already on screen" product decision lives
 * -- both handoff modes below call it and always end up saving something,
 * with no second tap and no separate fallback button:
 *
 *  - worker mode (service worker registered, tarek/p2pcontacts#68): the
 *    button is a bare <a href="…vcf">. Tapping it is a real navigation that
 *    sw.js intercepts, asking this page over postMessage for the vCard to
 *    serve. The answer is whatever awaitBestContact resolves at that
 *    moment.
 *  - download mode (no usable service worker): the click is handled here
 *    directly, awaiting the same helper before building and downloading a
 *    blob, exactly as worker mode does via the message channel instead.
 *
 * Either way the button shows a spinner for the (at most ~5s) wait: without
 * one, a worker-mode tap looks like the page is silently navigating away
 * rather than doing something, since nothing else on screen changes while
 * sw.js and this page's message handler are talking. The click handler that
 * starts the spinner does *not* call preventDefault() in worker mode --
 * it's a synchronous side effect of the same click, not a competing
 * navigation, so it doesn't reintroduce approach A's repeat-tap prompt (see
 * sw.js and tarek/p2pcontacts#68's linked research). A safety timer clears
 * it regardless, in case the fetch this tap started never reaches the
 * message handler at all.
 */
function wireSaveButton(offlineContact, onlinePromise) {
  const button = $("save");

  let current = offlineContact;
  let settled = false;
  let mode = "download"; // safe default until ensureServiceWorker says otherwise
  let spinnerSafety;

  function refreshHref() {
    if (mode === "worker") setSavePresentation(mode, buildVCardFile(current).filename);
  }

  onlinePromise.then(
    (onlineContact) => { current = onlineContact; },
    () => {},
  ).finally(() => {
    settled = true;
    refreshHref();
  });

  async function awaitBestContact() {
    if (!settled) {
      await Promise.race([
        onlinePromise.then(() => {}, () => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    return current;
  }

  function stopSpinner() {
    clearTimeout(spinnerSafety);
    setLoading(button, false);
  }

  setSavePresentation(mode, buildVCardFile(current).filename);

  ensureServiceWorker().then((ok) => {
    if (!ok) return;
    mode = "worker";
    refreshHref();
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type !== "build-vcard") return;
      awaitBestContact()
        .then((contact) => event.ports[0].postMessage(toVCard3(contact)))
        .finally(stopSpinner);
    });
  });

  button.addEventListener("click", (e) => {
    if (mode === "worker") {
      setLoading(button, true);
      spinnerSafety = setTimeout(stopSpinner, 6000);
      return;
    }
    e.preventDefault();
    setLoading(button, true);
    awaitBestContact()
      .then((contact) => {
        const { blob, filename } = buildVCardFile(contact);
        downloadViaLink(blob, filename, $("save-hint"));
      })
      .finally(stopSpinner);
  });
}

// ---------------------------------------------------------------- transport

class UnsupportedError extends Error {}
class AssetError extends Error {}
class TimeoutError extends Error {}

function checkSupport() {
  if (typeof WebAssembly !== "object" || typeof WebAssembly.instantiate !== "function") {
    throw new UnsupportedError("It doesn't support WebAssembly. Try Chrome, Safari, Firefox or Edge.");
  }
  if (typeof WebSocket !== "function") {
    throw new UnsupportedError("It doesn't support WebSockets.");
  }
}

async function pickDERPMapURL() {
  try {
    const resp = await fetch(new URL("derpmap.json", location.href), { method: "HEAD" });
    if (resp.ok) return new URL("derpmap.json", location.href).toString();
  } catch {}
  return canonicalDERPMapURL;
}

// Fetch the canonical wasm URL and let HTTP content negotiation select Brotli,
// gzip, or the uncompressed representation. fetch() unwraps Content-Encoding
// before exposing the body to JavaScript.
async function fetchWasm() {
  const count = (stream, total) => {
    let loaded = 0;
    return stream.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        if (total > 0) {
          console.log(`Fetching main.wasm: ${Math.min(100, Math.floor(100 * loaded / total))}% of ${(total / (1 << 20)).toFixed(1)} MB`);
        }
        controller.enqueue(chunk);
      },
    }));
  };

  const resp = await fetch("main.wasm");
  if (!resp.ok) throw new AssetError(`Fetching main.wasm returned ${resp.status}.`);
  // A compressed response's body is decoded but Content-Length, when present,
  // describes the encoded transfer, so it cannot be used as the progress total.
  const total = resp.headers.has("Content-Encoding")
    ? 0
    : Number(resp.headers.get("Content-Length")) || 0;
  return new Response(count(resp.body, total), { headers: { "Content-Type": "application/wasm" } });
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(onTimeout)), ms); }),
  ]);
}

/**
 * The whole path to a live vCard: checks browser support, loads and starts
 * the wasm dialer, connects to the sender's phone over Tailcat, and drains
 * the connection to EOF. Shared by url-only mode (the only way it ever gets
 * a vCard) and hybrid mode (its background upgrade past the offline one).
 *
 * Throws rather than failing the page itself -- url-only's caller treats
 * any rejection as fatal (nothing is on screen yet), hybrid's caller treats
 * it as "the offline data is all there will be."
 */
async function fetchOnline() {
  checkSupport();

  const derpMapURL = await pickDERPMapURL();
  mark("derp map located");

  const ready = new Promise((resolve) => { globalThis.onTailcatReady = resolve; });
  const go = new Go();
  const { instance } = await WebAssembly.instantiateStreaming(fetchWasm(), go.importObject);
  mark("wasm downloaded + compiled");

  go.run(instance);
  await ready;
  mark("wasm started");

  const conn = await withTimeout(
    tailcatDial({ addr, derpMapURL, port: PORT, verbose }),
    DIAL_TIMEOUT_MS,
    "dial",
  );
  mark("tunnel up");

  // Drain until EOF. The sender half-closes after the vCard, so a clean
  // null read means we have all of it. The connection itself stays open --
  // the sender half-closes only their write side -- so it remains usable
  // for a reply.
  const chunks = [];
  let first = true;
  for (;;) {
    const chunk = await conn.read();
    if (chunk === null) break;
    if (first) { mark("first byte"); first = false; }
    chunks.push(chunk);
  }
  mark("vCard received");

  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  chunks.reduce((off, c) => (bytes.set(c, off), off + c.length), 0);
  return { conn, text: new TextDecoder().decode(bytes), bytes: bytes.length };
}

// -------------------------------------------------------------------- reply

/**
 * The connection, kept open on purpose.
 *
 * The sender half-closes after writing their vCard, so our read side sees EOF
 * while our write side stays open -- which is what makes one connection enough
 * for an exchange rather than a handout. It stays up while someone fills in the
 * form, and the listener bounds that wait at its end.
 */
let conn = null;

/** Released on pagehide so the sender's goroutine ends when the tab does. */
addEventListener("pagehide", () => {
  try { conn?.close(); } catch {}
  conn = null;
});

/**
 * Builds the shape toVCard3 wants from two typed fields.
 *
 * Splitting a name into given and family is a guess -- first token, then the
 * rest -- and it is wrong for plenty of people. FN carries exactly what they
 * typed, which is the field that gets displayed; N is structure for importers
 * that want it, and a bad guess there is recoverable in a way a mangled FN is
 * not.
 */
function replyContact(fullName, phone) {
  const parts = fullName.trim().split(/\s+/);
  const given = parts[0] || "";
  const family = parts.slice(1).join(" ");
  return {
    fn: fullName.trim(),
    n: { family, given, middle: "", prefix: "", suffix: "" },
    org: [], title: "", bday: "", note: "", photo: null,
    tels: phone.trim() ? [{ value: phone.trim(), types: ["CELL"] }] : [],
    emails: [], urls: [], adrs: [],
  };
}

/**
 * Wires the "send yours back" card against `offlineContact` immediately --
 * visible and interactive right away, not waiting on `onlinePromise`. A
 * submit before the connection is ready shows a spinner and waits on it
 * (bounded only by fetchOnline's own DIAL_TIMEOUT_MS, no separate timeout);
 * a submit after it settles proceeds or fails immediately.
 *
 * Unlike the save button, there is no offline fallback here if the
 * connection never comes -- the offline data is the sender's, not
 * something to substitute for the recipient's own outbound write -- so a
 * failure is surfaced as an honest error instead, reusing the wording
 * url-only mode's own dial failure uses.
 */
function wireReplyButton(offlineContact, onlinePromise) {
  const card = $("reply");
  const form = $("reply-form");
  const name = $("reply-name");
  const tel = $("reply-tel");
  const send = $("reply-send");
  const error = $("reply-error");

  let theirContact = offlineContact;
  let settled = false;
  let failed = false;

  function firstName(c) {
    return c.fn?.trim().split(/\s+/)[0];
  }

  function updateSub() {
    const theirs = firstName(theirContact);
    $("reply-sub").textContent = theirs ? `So ${theirs} has your details too.` : "So they have your details too.";
  }
  updateSub();

  onlinePromise.then(
    (onlineContact) => { theirContact = onlineContact; updateSub(); },
    () => { failed = true; },
  ).finally(() => { settled = true; });

  // navigator.contacts is Chrome on Android and nowhere else -- not iOS, not
  // desktop. Checked rather than attempted, so the button is never offered
  // where tapping it would do nothing.
  if (navigator.contacts?.select) {
    const pick = $("pick-contact");
    pick.hidden = false;
    pick.addEventListener("click", async () => {
      try {
        const [picked] = await navigator.contacts.select(["name", "tel"], { multiple: false }) || [];
        if (!picked) return;
        if (picked.name?.[0]) name.value = picked.name[0];
        if (picked.tel?.[0]) tel.value = picked.tel[0];
      } catch {
        // Dismissed, or the picker refused. The fields are still there.
      }
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;

    if (!name.value.trim()) {
      error.textContent = "A name, at least.";
      error.hidden = false;
      name.focus();
      return;
    }

    if (!settled) {
      setLoading(send, true);
      await onlinePromise.then(() => {}, () => {});
      setLoading(send, false);
    }

    if (!conn) {
      error.textContent = failed
        ? "Couldn't reach the sender. Their phone has to be sharing for this link to work. " +
          "Ask them to open the app again, then scan the new code."
        : "The connection closed. Reload the page and try again.";
      error.hidden = false;
      return;
    }

    setLoading(send, true);
    send.querySelector(".label").textContent = "Sending…";
    try {
      const bytes = new TextEncoder().encode(toVCard3(replyContact(name.value, tel.value)));
      await conn.write(bytes);
      // Half-close so the sender sees a clean EOF and knows it has all of it,
      // exactly as they did for us.
      await conn.closeWrite();
      conn.close();
      conn = null;

      form.hidden = true;
      $("reply-done").hidden = false;
      const theirs = firstName(theirContact);
      $("reply-done-sub").textContent = theirs
        ? `${theirs} can now save your details.`
        : "They can now save your details.";
      window.pocResult.replied = true;
    } catch (err) {
      setLoading(send, false);
      send.querySelector(".label").textContent = "Send";
      error.textContent = "Couldn't send that. They may have stopped sharing.";
      error.hidden = false;
      window.pocResult.replyError = String(err?.message || err);
    }
  });

  card.hidden = false;
}

// --------------------------------------------------------------------- render+wire

/**
 * Turns raw vCard text into the rendered contact, for url-only mode -- the
 * only path where nothing is on screen until this succeeds, so an empty or
 * unreadable payload is a fatal, honestly-explained failure rather than
 * something to render around. Hybrid mode's offline render goes through
 * parseVCardOrBlank + renderContact directly instead; see runHybrid.
 */
function renderVCardText(text) {
  window.pocResult.vcard = text;
  if (!/BEGIN:VCARD/i.test(text)) {
    fail("That wasn't a contact", "The sender sent something this page can't read.");
  }
  const contact = parseVCard(text);
  if (!contact || (!contact.fn && !displayRows(contact).length)) {
    fail("That contact was empty", "The sender's card had nothing in it to show.");
  }
  window.pocResult.contact = contact;
  renderContact(contact);
  return contact;
}

/**
 * Hybrid mode's whole flow: render the offline vCard from the URL right
 * away -- whatever it contains, even nothing -- then fetch the live vCard
 * in the background and transparently re-render in place once it lands.
 * The save and reply UI are both wired immediately, before fetchOnline
 * even starts, so neither is hidden or disabled while the phone connects.
 */
async function runHybrid(embeddedVCardText) {
  const offlineContact = parseVCardOrBlank(embeddedVCardText);
  window.pocResult.vcard = embeddedVCardText;
  window.pocResult.contact = offlineContact;
  renderContact(offlineContact);
  $("avatar").classList.add("loading");
  mark("rendered from URL");
  window.pocResult.done = true;

  const onlinePromise = fetchOnline().then(({ conn: c, text }) => {
    conn = c;
    const onlineContact = parseVCardOrBlank(text);
    window.pocResult.vcard = text;
    window.pocResult.contact = onlineContact;
    window.pocResult.online = true;
    renderContact(onlineContact);
    return onlineContact;
  });
  // Stops breathing either way: online data replaces the placeholder it
  // was hinting more was coming for, and a failure means nothing more is
  // coming to wait for.
  onlinePromise.finally(() => { $("avatar").classList.remove("loading"); });
  // A rejection here just means the offline data is all there will be --
  // wireSaveButton and wireReplyButton each observe it themselves, so it
  // must not surface as an unhandled rejection on top of that.
  onlinePromise.catch(() => {});

  wireSaveButton(offlineContact, onlinePromise);
  wireReplyButton(offlineContact, onlinePromise);
}

// --------------------------------------------------------------------- main

async function main() {
  // Kicked off here, unawaited, so it has as long as possible to resolve
  // before wireSaveButton needs an answer -- url-only mode in particular
  // doesn't wire the save button until fetchOnline() finishes, which is
  // usually much slower than a service-worker registration.
  ensureServiceWorker();

  if (!addr) {
    fail("No contact code in this link",
         "Scan the sender's QR code to open the right link.");
  }
  if (!addr.startsWith("tc")) {
    fail("This link doesn't look right",
         "The contact code is malformed. Scan the sender's QR code again.");
  }

  if (embeddedVCard !== null) {
    // A present-but-empty v= is still hybrid mode -- flexible offline data
    // includes "none at all" -- so this checks presence, not truthiness.
    await runHybrid(embeddedVCard);
    return;
  }

  let online;
  try {
    online = await fetchOnline();
  } catch (e) {
    if (e instanceof UnsupportedError) {
      fail("This browser can't open the contact", e.message);
    } else if (e instanceof AssetError) {
      fail("Couldn't load the page", e.message);
    } else {
      // The address is minted per sharing session and dies with it, so this is
      // overwhelmingly "they stopped sharing", not "the network is bad".
      fail("Couldn't reach the sender",
           "Their phone has to be sharing for this link to work. Ask them to open " +
           "the app again, then scan the new code.");
    }
    return;
  }

  conn = online.conn;
  window.pocResult.bytes = online.bytes;
  window.pocResult.online = true;

  const contact = renderVCardText(online.text);
  const resolved = Promise.resolve(contact);
  wireSaveButton(contact, resolved);
  wireReplyButton(contact, resolved);
  mark("rendered");

  window.pocResult.done = true;
}

main().catch((err) => {
  if (err instanceof PageError) return;      // already rendered
  const msg = String(err?.message || err);
  window.pocResult.error = msg;
  window.pocResult.done = true;
  $("loading").hidden = true;
  $("error").hidden = false;
  $("error-title").textContent = "Something went wrong";
  $("error-detail").textContent = msg;
});
