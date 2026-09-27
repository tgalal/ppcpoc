// P2P Contacts -- service worker for the "Save to contacts" handoff.
//
// This is what makes iOS Safari (and any other browser that supports it)
// open the native Add Contact screen: a plain <a href="…vcf"> navigation is
// intercepted here and answered with a text/vcard response, generated on
// demand rather than served as a static file. See tarek/p2pcontacts#68.
//
// The worker deliberately does not know how to build a vCard itself -- the
// page already has toVCard3/buildVCardFile, so this just relays whatever
// text the page currently has to offer. Only .vcf requests are touched;
// everything else (the page itself, main.wasm, ...) passes straight through
// and this worker's presence changes nothing about how the rest of the site
// loads.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const VCARD_TYPE = "text/vcard; charset=utf-8";

// The page waits up to 5s for the online vCard before answering with
// whatever it already has (see awaitBestContact in app.js), so this ceiling
// needs headroom above that -- it is the "something is actually stuck"
// timeout, not the "wait for better data" one.
const CLIENT_TIMEOUT_MS = 8000;

function askClient(client) {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("client did not reply in time")), CLIENT_TIMEOUT_MS);
    ch.port1.onmessage = (ev) => { clearTimeout(timer); resolve(ev.data); };
    client.postMessage({ type: "build-vcard" }, [ch.port2]);
  });
}

async function fromClient() {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (!wins.length) return new Response("no window client", { status: 503 });
  try {
    const text = await askClient(wins[0]);
    return new Response(text, { headers: { "Content-Type": VCARD_TYPE } });
  } catch (err) {
    return new Response(`failed: ${err.message}`, { status: 504 });
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.endsWith(".vcf")) return;
  event.respondWith(fromClient());
});
