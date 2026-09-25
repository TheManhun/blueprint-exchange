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

// Blueprint types, worked out from the blueprint's own data (what it places
// and which street/track/bridge types it lists) -- never typed in. The
// database does the same in bp_categories() (supabase/migrations/
// bp_categories.sql): keep the two in step. The order is the display order.
const BPX_CATEGORY_ORDER = ["Truck station", "Bus station", "Rail station", "Airport", "Harbour", "Depot", "Road network", "Rail network", "Bridges & tunnels", "Other"];

function bpxCategories(text) {
  const t = String(text || "");
  const cats = [];
  const streetStation = /fileName = "station\/street\//.test(t);
  if (streetStation && /station\/street\/(cargo_platform|era_[a-z]_cargo_building)/.test(t)) cats.push("Truck station");
  if (streetStation && /station\/street\/(passenger_platform|era_[a-z]_passenger_building)/.test(t)) cats.push("Bus station");
  if (/fileName = "station\/rail\//.test(t)) cats.push("Rail station");
  if (/fileName = "station\/air\//.test(t)) cats.push("Airport");
  if (/fileName = "station\/water\//.test(t)) cats.push("Harbour");
  if (/fileName = "depot\//.test(t)) cats.push("Depot");
  // plain infrastructure only when nothing station-like (even an unrecognised one) is placed
  if (cats.length === 0 && !/fileName = "(station|depot)\//.test(t)) {
    if (/streets = \{"/.test(t)) cats.push("Road network");
    if (/tracks = \{"/.test(t)) cats.push("Rail network");
  }
  if (/bridges = \{"/.test(t) || /tunnels = \{"/.test(t)) cats.push("Bridges & tunnels");
  return cats.length ? cats : ["Other"];
}

// Features shown as grey/green dots on the upload page, read from the same
// data as the types above. Order = display order.
const BPX_FEATURES = [
  ["cargoTrain", "Cargo train station"],
  ["passengerTrain", "Passenger train station"],
  ["cargoTruck", "Cargo truck station"],
  ["bus", "Bus station"],
  ["depot", "Depot"],
  ["signals", "Signals"],
  ["tracks", "Train tracks"],
  ["road", "Roads"],
  ["bridge", "Bridge"],
  ["tunnel", "Tunnel"],
];

function bpxFeatures(text) {
  const t = String(text || "");
  const rail = /fileName = "station\/rail\//.test(t);
  const street = /fileName = "station\/street\//.test(t);
  return {
    cargoTrain: rail && /platform_cargo_era_|(main|side)_building_\d_cargo|cargo_platform = true/.test(t),
    passengerTrain: rail && /station\/rail\/modular_station\/platform_passenger/.test(t),
    cargoTruck: street && /station\/street\/(cargo_platform|era_[a-z]_cargo_building)/.test(t),
    bus: street && /station\/street\/(passenger_platform|era_[a-z]_passenger_building)/.test(t),
    depot: /fileName = "depot\//.test(t),
    signals: /models = \{[^}]*signal/.test(t),
    tracks: /tracks = \{"/.test(t),
    road: /streets = \{"/.test(t),
    bridge: /bridges = \{"/.test(t),
    tunnel: /tunnels = \{"/.test(t),
  };
}

// ---------------------------------------------------------------------------
// Workshop mods (Plug My Mod / blueprint dependencies): one Edge Function
// verifies items with Steam and stores the results. Shared by the upload page.
// ---------------------------------------------------------------------------
const BPX_MODS_FN = SUPABASE_URL + "/functions/v1/plug-my-mod";

async function bpxModsCall(payload) {
  let res;
  try {
    res = await fetch(BPX_MODS_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
  }
  try { return await res.json(); }
  catch (e) { return { ok: false, error: "The server sent back something unexpected. Please try again." }; }
}

function bpxWaitText(sec) {
  if (typeof sec !== "number" || !isFinite(sec) || sec <= 0) return "";
  if (sec < 90) return " Try again in " + Math.ceil(sec) + " second" + (Math.ceil(sec) === 1 ? "" : "s") + ".";
  if (sec < 5400) return " Try again in about " + Math.ceil(sec / 60) + " minutes.";
  return " Try again in about " + Math.ceil(sec / 3600) + " hours.";
}

function bpxFailText(r) {
  const base = (r && r.error) || "Something went wrong. Please try again.";
  const wait = bpxWaitText(r && r.retryAfter);
  return (wait ? base.replace(/ Please try again[^.]*\./, "") : base) + wait;
}

// The only Steam link the pages ever build from a Workshop id.
// The only mod.io link the pages ever show: the exact shape mod.io uses for Transport Fever 2.
const bpxModioUrl = (url) => /^https:\/\/mod\.io\/g\/transportfever2\/m\/[A-Za-z0-9_-]{1,80}$/.test(String(url || "")) ? url : null;
// Link + label for a mod of either kind, as returned by bp_list / bp_dependency_report.
function bpxModLink(m) {
  if (m && m.platform === "modio") {
    const u = bpxModioUrl(m.url);
    return u ? { url: u, label: "View on mod.io" } : null;
  }
  const u = bpxSteamUrl(m && m.workshop_id);
  return u ? { url: u, label: "View on Steam Workshop" } : null;
}
const bpxSteamUrl = (id) => /^[0-9]{1,15}$/.test(String(id)) ? "https://steamcommunity.com/sharedfiles/filedetails/?id=" + id : null;

// One blueprint card, used by the library and by the live preview on the
// upload page, so what people see there is exactly what they will get.
function blueprintCardHtml(b, opts) {
  const preview = !!(opts && opts.preview);
  const owned = !!(opts && opts.owned);
  // Mods this blueprint needs, worked out by the library (see bp_list): the
  // Workshop mods BPX has identified, and any external content it could not.
  const mods = Array.isArray(b.mods) ? b.mods : [];
  const unresolved = Array.isArray(b.unresolved) ? b.unresolved : [];
  const reqHtml = (mods.length || unresolved.length) ? `<details class="reqs">
      <summary>${mods.length ? `Requires: ${mods.length} Workshop mod${mods.length === 1 ? "" : "s"}` : "Requires external content"}${mods.length && unresolved.length ? " + unidentified content" : ""}</summary>
      ${mods.length ? `<div class="reqhead">Required Mods</div><ul>${mods.map((m) => { const link = bpxModLink(m); return `<li>${esc(m.name)}${link ? ` <a class="btn small" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${link.label}</a>` : ""}</li>`; }).join("")}</ul>` : ""}
      ${unresolved.length ? `<div class="reqhead">Unresolved external content:</div><ul>${unresolved.map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` : ""}
    </details>` : "";
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
    ${(b.categories || []).length ? `<div class="cats">${b.categories.map((c) => `<span class="cat">${esc(c)}</span>`).join("")}</div>` : ""}
    <p class="desc">${esc(b.description || "")}</p>
    <div class="meta">${fmt(b.constructions)} construction${b.constructions === 1 ? "" : "s"} &middot; ${fmt(b.edges)} segment${b.edges === 1 ? "" : "s"} &middot; ${Math.round((b.size || 0) / 1024)} KB</div>
    ${reqHtml}
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
