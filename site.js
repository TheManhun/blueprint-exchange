// Blueprint Exchange -- shared by every page that talks to Supabase.
// Load AFTER the supabase-js script and BEFORE the page's own script.

const SUPABASE_URL = "https://aijqcrrcreectihaeqoc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_R3nt2zIP1QF6iJiGfJ220A_zX3JTQ0_";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Same rule as the mod's bp_files.sanitizeName, so the file name the
// page hands out is exactly what the mod expects.
const sanitize = (s) => (s || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
const fmt = (n) => Number(n || 0).toLocaleString();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Pages opened from disk or from a local test server are the author (or
// a test browser) looking at work in progress, not a visitor, so they
// are never recorded.
function isLocalView() {
  return location.protocol === "file:" || ["localhost", "127.0.0.1", "[::1]", ""].indexOf(location.hostname) !== -1;
}

// Unique visitors: a random id the browser keeps in localStorage, nothing
// tied to a real identity or an IP address. Sent once per browser session
// to bp_track_visit, the only thing on the server that ever sees it (no
// direct table access from here).
function getOrMakeVisitorId() {
  try {
    const key = "bpxVisitorId";
    let id = localStorage.getItem(key);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^a-zA-Z0-9_-]/g, "");
      localStorage.setItem(key, id);
    }
    return id;
  } catch (err) {
    return null; // private browsing etc. -- skip tracking, never break the page over it
  }
}

async function trackVisit() {
  if (isLocalView()) return;
  try {
    if (sessionStorage.getItem("bpxVisitSent")) return; // one visit per session, not one per page
  } catch (err) { /* no sessionStorage: fall through and count the load */ }
  const visitorId = getOrMakeVisitorId();
  if (!visitorId) return;
  try {
    await sb.rpc("bp_track_visit", { p_visitor_id: visitorId });
    try { sessionStorage.setItem("bpxVisitSent", "1"); } catch (err) { /* fine */ }
  } catch (err) { /* never break the page over this */ }
}

// One blueprint card, used by the library and by the live preview on the
// upload page, so what people see there is exactly what they will get.
function blueprintCardHtml(b, opts) {
  const preview = !!(opts && opts.preview);
  const req = (b.requires && b.requires.constructions) || [];
  const thumb = b.thumbnail_url
    ? `<img class="thumb" src="${esc(b.thumbnail_url)}" alt="Preview of ${esc(b.name)}" width="480" height="270" loading="lazy">`
    : `<img class="thumb thumb-placeholder" src="card-noimage.webp" alt="No preview image supplied for ${esc(b.name)}" width="480" height="270" loading="lazy">`;
  const button = preview
    ? `<button class="primary" type="button" disabled>Download</button>`
    : `<button class="primary" data-id="${b.id}" data-name="${esc(b.name)}">Download</button>`;
  return `<article class="card${b.official ? " official" : ""}">
    ${thumb}
    <h3>${esc(b.name)}${b.official ? ' <span class="badge">Official</span>' : ""}</h3>
    <div class="meta">${esc(b.author || "anonymous")} &middot; ${new Date(b.created_at).toLocaleDateString()} &middot; v${b.version || 1}${(b.version || 1) > 1 ? " (updated)" : ""} &middot; ${fmt(b.downloads)} download${b.downloads === 1 ? "" : "s"}</div>
    <p class="desc">${esc(b.description || "")}</p>
    <div class="meta">${fmt(b.constructions)} construction${b.constructions === 1 ? "" : "s"} &middot; ${fmt(b.edges)} segment${b.edges === 1 ? "" : "s"} &middot; ${Math.round((b.size || 0) / 1024)} KB</div>
    ${req.length ? `<div class="req">needs: ${esc(req.join(", "))}</div>` : ""}
    <div class="row">${button}</div>
  </article>`;
}
