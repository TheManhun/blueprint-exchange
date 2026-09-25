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
  const owned = !!(opts && opts.owned);
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
    <div class="row">${button}${owned && b.blueprint_id ? `<a class="btn" href="edit.html?b=${encodeURIComponent(b.blueprint_id)}">Edit</a>` : ""}</div>
  </article>`;
}

// ---------------------------------------------------------------------------
// Ownership (no accounts). The original blueprint file carries a private key
// that never leaves the uploader's PC except inside the upload itself; the
// server keeps only its hash. A browser that has proved it holds the file is
// given a random token. The token lives in localStorage (a cookie can't be
// shared with the Supabase domain), the server keeps only the token's HASH,
// and it can only ever do what it was authorised for. The private key itself
// is never stored in the browser.
// ---------------------------------------------------------------------------
const BPX_TOKEN_KEY = "bpxBrowserToken";
let bpxMemoryToken = null; // used if localStorage is unavailable (this page load only)

function bpxGetToken(create) {
  try {
    let t = localStorage.getItem(BPX_TOKEN_KEY);
    if (/^[0-9a-f]{64}$/.test(t || "")) return t;
    if (!create) return bpxMemoryToken;
    t = bpxRandomToken();
    localStorage.setItem(BPX_TOKEN_KEY, t);
    return t;
  } catch (err) {
    if (!bpxMemoryToken && create) bpxMemoryToken = bpxRandomToken();
    return bpxMemoryToken;
  }
}

function bpxRandomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Blueprints this browser may manage, newest first. [] if none / no token.
async function bpxOwned() {
  const token = bpxGetToken(false);
  if (!token) return [];
  try {
    const { data, error } = await sb.rpc("bp_my_blueprints", { p_token: token });
    if (error || !Array.isArray(data)) return [];
    return data;
  } catch (err) { return []; }
}

// Prove ownership with the original file's key and authorise this browser.
// Resolves to { ok, name, version } or { ok:false, code }.
async function bpxClaim(blueprintId, ownerSecret) {
  try {
    const { data, error } = await sb.rpc("bp_claim_browser", {
      p_token: bpxGetToken(true), p_blueprint_id: blueprintId, p_owner_secret: ownerSecret,
    });
    if (error || !data) return { ok: false };
    return data;
  } catch (err) { return { ok: false }; }
}

// The original .lua's ownership fields, read as plain text -- the file is
// never run. Returns { blueprintId, ownerSecret } (either may be null).
function bpxReadOwnership(text) {
  return {
    blueprintId: (text.match(/\bblueprintId = "([0-9a-f]+)"/) || [, null])[1],
    ownerSecret: (text.match(/\bownerSecret = "([0-9a-f]+)"/) || [, null])[1],
  };
}

const BPX_KEEP_SAFE_HTML = `<strong>Keep your original blueprint .lua file safe.</strong>
  <p>It is your ownership/recovery key for editing this upload later.</p>
  <p>Your public downloadable blueprint does not contain the private edit key.</p>`;
