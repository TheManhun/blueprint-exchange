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
const BPX_CATEGORY_ORDER = ["Truck station", "Bus station", "Rail station", "Airport", "Harbour", "Depot", "Industry", "Road network", "Rail network", "Bridges & tunnels", "Other"];

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
// Blueprint Manager 'Compare my mods': the mod numbers the player chose to read from their own mods folders, kept in
// this browser only (bpx-folder.js, localStorage bpxMyMods). null when they haven't -- then cards say nothing.
function bpxMyModSets() {
  try {
    const m = JSON.parse(localStorage.getItem("bpxMyMods") || "null");
    return m ? { ws: new Set(m.workshop || []), mio: new Set(m.modio || []) } : null;
  } catch (err) { return null; }
}
function bpxModsCheck(b) {
  const mods = Array.isArray(b.mods) ? b.mods : [];
  const mine = mods.length && bpxMyModSets();
  if (!mine) return null;
  const missing = mods.filter((m) => !((m.workshop_id && mine.ws.has(String(m.workshop_id))) || (m.modio_id && mine.mio.has(String(m.modio_id))))).length;
  return { missing };
}

function bpxModLink(m) {
  if (m && m.platform === "modio") {
    const u = bpxModioUrl(m.url);
    return u ? { url: u, label: "View on mod.io" } : null;
  }
  const u = bpxSteamUrl(m && m.workshop_id);
  return u ? { url: u, label: "View on Steam Workshop" } : null;
}
const bpxSteamUrl = (id) => /^[0-9]{1,15}$/.test(String(id)) ? "https://steamcommunity.com/sharedfiles/filedetails/?id=" + id : null;

// ---------------------------------------------------------------------------
// CONTENTS -- what a blueprint holds, in the mod's own icon language (the
// in-game Library row): "station:1;bus:2;road:23;other:1". Stored per blueprint
// (bp_blueprints.contents); the card's Contents button drops the icons over the
// picture. Icons are the mod's own list icons, in icons/<key>.png.
// ---------------------------------------------------------------------------
const BPX_CONTENT_ORDER = ["coal", "ironore", "crude", "forest", "stone", "grain", "chemical", "materials", "food",
  "fuel", "goods", "machines", "refinery", "sawmill", "steel", "tools", "industry",
  "station", "bus", "truck", "bays", "air", "harbour", "track", "road",
  "railbridge", "roadbridge", "railtunnel", "roadtunnel", "mods"];
const BPX_CONTENT_NAMES = {
  coal: "Coal mine", ironore: "Iron ore mine", crude: "Oil well", forest: "Forest", stone: "Quarry", grain: "Farm",
  chemical: "Chemical plant", materials: "Building materials plant", food: "Food processing plant", fuel: "Fuel refinery",
  goods: "Goods factory", machines: "Machines factory", refinery: "Oil refinery", sawmill: "Saw mill", steel: "Steel mill",
  tools: "Tools factory", industry: "Industry", station: "Train station", bus: "Bus station", truck: "Truck station", bays: "Bus / truck bays",
  air: "Airport", harbour: "Harbour", track: "Track pieces", road: "Road pieces", railbridge: "Rail bridge pieces",
  roadbridge: "Road bridge pieces", railtunnel: "Rail tunnel pieces", roadtunnel: "Road tunnel pieces", mods: "Mods needed",
};
const BPX_INDUSTRY_KIND = {
  coal_mine: "coal", iron_ore_mine: "ironore", oil_well: "crude", forest: "forest", quarry: "stone", farm: "grain",
  chemical_plant: "chemical", construction_material: "materials", food_processing_plant: "food", fuel_refinery: "fuel",
  goods_factory: "goods", machines_factory: "machines", oil_refinery: "refinery", saw_mill: "sawmill",
  steel_mill: "steel", tools_factory: "tools",
};

// The mod's bp_summary.categorize, line for line, over a parsed blueprint (for
// new uploads -- the existing ones were counted by the mod's own code).
function bpxContentsOf(bp) {
  const counts = {};
  const add = (k, n) => { counts[k] = (counts[k] || 0) + (n || 1); };
  const list = (v) => Array.isArray(v) ? v
    : (v && typeof v === "object" ? Object.keys(v).filter((k) => k !== "__array").map((k) => v[k]).concat(v.__array || []) : []);
  for (const piece of list(bp && bp.constructions)) {
    const file = String((piece && piece.fileName) || "");
    if (/^industry\//.test(file)) {
      const m = /^industry\/(.*?)\.con$/.exec(file);
      add(BPX_INDUSTRY_KIND[m ? m[1] : ""] || "industry");
    } else if (/^station\/rail/.test(file)) add("station");
    else if (/^station\/air/.test(file) || /airport|airfield/.test(file)) add("air");
    else if (/^station\/water/.test(file) || /harbo/.test(file)) add("harbour");
    else if (/^station\/street/.test(file)) {
      let cargo = false, passenger = false;
      for (const mod of list(piece.params && piece.params.modules)) {
        const md = mod && mod.metadata;
        if (md && typeof md === "object") { if (md.cargo) cargo = true; if (md.passenger) passenger = true; }
      }
      if (cargo && passenger) { add("bus"); add("truck"); }
      else if (cargo) add("truck");
      else if (passenger) add("bus");
      else if (/truck|cargo/.test(file)) add("truck");
      else add("bus");
    } else add("other");
  }
  for (const e of list(bp && bp.edges)) {
    const track = !!e && e.track === true;
    if (e && e.edgeType === 1) add(track ? "railbridge" : "roadbridge");
    else if (e && e.edgeType === 2) add(track ? "railtunnel" : "roadtunnel");
    else add(track ? "track" : "road");
  }
  // the bus + truck terminals' bays: the columns holding platform modules (bp_summary terminalBays)
  let bays = 0;
  for (const piece of list(bp && bp.constructions)) {
    const modules = piece && piece.params && piece.params.modules;
    if (!/modular_terminal/.test(String((piece && piece.fileName) || "")) || !modules || typeof modules !== "object") continue;
    const cols = { bus: new Set(), truck: new Set() };
    for (const slot of Object.keys(modules)) {
      const name = String((modules[slot] && modules[slot].name) || "");
      if (name.includes("_platform.module") && /^[0-9]+$/.test(slot)) {
        cols[name.includes("cargo") ? "truck" : "bus"].add((Math.floor(Number(slot) / 100) % 2000) - 100);
      }
    }
    bays += cols.bus.size + cols.truck.size;
  }
  if (bays > 0) add("bays", bays);
  const mods = list(bp && bp.requiredMods).length;
  if (mods > 0) add("mods", mods);
  const parts = BPX_CONTENT_ORDER.filter((k) => counts[k]).map((k) => k + ":" + counts[k]);
  if (counts.other) parts.push("other:" + counts.other);
  return parts.join(";");
}

// "track:13;other:2" -> the chips laid over the picture
function bpxContentsHtml(contents) {
  const items = String(contents || "").split(";").map((p) => /^([a-z]+):(\d+)$/.exec(p)).filter(Boolean);
  return items.map((m, i) => m[1] === "other"
    ? `<span class="cchip cchip-other" style="--i:${i}" title="Other pieces (depots, assets...)">+${esc(m[2])} other</span>`
    : BPX_CONTENT_NAMES[m[1]]
      ? `<span class="cchip" style="--i:${i}" title="${esc(BPX_CONTENT_NAMES[m[1]])}: ${esc(m[2])}"><img src="icons/${m[1]}.png" alt="${esc(BPX_CONTENT_NAMES[m[1]])}" width="28" height="28"><b>${esc(m[2])}</b></span>`
      : "").join("");
}

// Contents button: show / hide the chips (delegated once, like the view toggle)
if (typeof document !== "undefined") {
  document.addEventListener("click", function (e) {
    const btn = e.target.closest ? e.target.closest(".contentsToggle") : null;
    if (!btn) return;
    const wrap = btn.closest(".thumbwrap");
    const layer = wrap ? wrap.querySelector(".contentsLayer") : null;
    if (!layer) return;
    const show = layer.hidden;
    layer.hidden = !show;
    btn.setAttribute("aria-pressed", String(show));
    btn.textContent = show ? "Hide contents" : "Contents";
  });
}

// One blueprint card, used by the library and by the live preview on the
// upload page, so what people see there is exactly what they will get.
// Card image toggle: screenshot <-> drawn schematic (delegated once; cards
// are re-rendered wholesale, listeners on them would be lost).
if (typeof document !== "undefined") {
  document.addEventListener("click", function (e) {
    const btn = e.target.closest ? e.target.closest(".thumbToggle") : null;
    if (!btn) return;
    const wrap = btn.closest(".thumbwrap");
    const img = wrap ? wrap.querySelector("img.thumb") : null;
    if (!img || !img.dataset.schem) return;
    const showingSchem = img.src === img.dataset.schem;
    img.src = showingSchem ? img.dataset.photo : img.dataset.schem;
    btn.textContent = showingSchem ? "Blueprint view" : "Screenshot";
    btn.setAttribute("aria-pressed", showingSchem ? "false" : "true");
  });
}

function blueprintCardHtml(b, opts) {
  const preview = !!(opts && opts.preview);
  const owned = !!(opts && opts.owned);
  // Mods this blueprint needs, worked out by the library (see bp_list): the
  // Workshop mods BPX has identified, and any external content it could not.
  const mods = Array.isArray(b.mods) ? b.mods : [];
  const unresolved = Array.isArray(b.unresolved) ? b.unresolved : [];
  const modsCheck = bpxModsCheck(b);
  const reqHtml = (mods.length || unresolved.length) ? `<details class="reqs">
      <summary>${mods.length ? `Requires: ${mods.length} Workshop mod${mods.length === 1 ? "" : "s"}` : "Requires external content"}${mods.length && unresolved.length ? " + unidentified content" : ""}${modsCheck ? (modsCheck.missing ? ` <span class="modhave miss">you're missing ${modsCheck.missing}</span>` : ` <span class="modhave ok">you have ${mods.length === 1 ? "it" : "them all"}</span>`) : ""}</summary>
      ${mods.length ? `<div class="reqhead">Required Mods</div><ul>${mods.map((m) => { const link = bpxModLink(m); return `<li>${esc(m.name)}${link ? ` <a class="btn small" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${link.label}</a>` : ""}</li>`; }).join("")}</ul>` : ""}
      ${unresolved.length ? `<div class="reqhead">Unresolved external content:</div><ul>${unresolved.map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` : ""}
    </details>` : "";
  const hasBothViews = !!(b.schematic_url && b.thumbnail_url && b.schematic_url !== b.thumbnail_url);
  const chips = bpxContentsHtml(b.contents);
  const contentsHtml = chips
    ? `<div class="contentsLayer" hidden>${chips}</div>
       <button type="button" class="contentsToggle" aria-pressed="false" title="What this blueprint holds -- the same icons the mod shows">Contents</button>`
    : "";
  const thumb = b.thumbnail_url
    ? `<div class="thumbwrap">
         <img class="thumb" src="${esc(b.thumbnail_url)}" data-photo="${esc(b.thumbnail_url)}"${hasBothViews ? ` data-schem="${esc(b.schematic_url)}"` : ""} alt="Preview of ${esc(b.name)}" width="480" height="270" loading="lazy">
         ${hasBothViews ? `<button type="button" class="thumbToggle" aria-pressed="false" title="Switch between the screenshot and the blueprint schematic">Blueprint view</button>` : ""}
         ${contentsHtml}
       </div>`
    : `<div class="thumbwrap">
         <img class="thumb thumb-placeholder" src="card-noimage.webp" alt="No preview image supplied for ${esc(b.name)}" width="480" height="270" loading="lazy">
         ${contentsHtml}
       </div>`;
  // Pre-installed: ships inside the mod (in game: Show: Built-in), so there is nothing to
  // download. downloadable = false is the general switch (the server refuses those too).
  const pre = !!b.preinstalled;
  const canDownload = b.downloadable !== false && !pre;
  const button = pre
    ? `<span class="btn preinst" title="Already in your game: BPX Library, Show: Built-in">Pre-installed with BPX</span>`
    : !canDownload
      ? `<button class="primary" type="button" disabled>Not available to download</button>`
      : preview
        ? `<button class="primary" type="button" disabled>Download</button>`
        : `<button class="primary" data-id="${b.id}" data-name="${esc(b.name)}">Download</button>`;
  const metaLine = pre
    ? `${esc(b.author || "BPX Default")} &middot; comes with the mod &middot; in game: Library &rarr; Show: Built-in`
    : `${esc(b.author || "anonymous")} &middot; ${new Date(b.created_at).toLocaleDateString()} &middot; v${b.version || 1}${(b.version || 1) > 1 ? " (updated)" : ""} &middot; ${fmt(b.downloads)} download${b.downloads === 1 ? "" : "s"}`;
  return `<article class="card${b.official ? " official" : ""}${pre ? " preinstalled" : ""}">
    ${thumb}
    <h3>${esc(b.name)}${b.official ? ' <span class="badge">Official</span>' : ""}${pre ? ' <span class="badge pre">Pre-installed</span>' : ""}</h3>
    <div class="meta">${metaLine}</div>
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

// ---------------------------------------------------------------------------
// The downloaded file (moved here from the library page so the Blueprint Manager's
// 'Send to game' stamps files exactly the same way).
// ---------------------------------------------------------------------------
// Lua %q-style string literal.
const luaStr = (s) => '"' + String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n") + '"';

// The file the page hands out is the stored text with identity stamped
// in: origin -> "community", plus author/description/version so they
// travel with the file even when it's passed on by hand. Any existing
// origin/author/description/version keys are replaced.
//
// Mod names travel too: the mod records a Workshop mod by id only, so the
// game would show "Workshop 1234567". The library knows each mod's name
// (bp_dependency_report), so the file gets modNames = { ["id"] = "name" },
// and -- for an older upload with no requiredMods record at all -- a
// requiredMods list built from the same report, so the game can name what
// is missing instead of counting files.
async function modStamp(text, row) {
  if (!row.requires) return "";
  const { data, error } = await sb.rpc("bp_dependency_report", { p_requires: row.requires });
  if (error || !Array.isArray(data)) return "";
  const mods = new Map(); // workshop id -> { name, paths }
  for (const item of data) {
    const m = item && item.status === "mod" && item.mod;
    if (!m || !/^\d+$/.test(String(m.workshop_id))) continue;
    const id = String(m.workshop_id);
    if (!mods.has(id)) mods.set(id, { name: m.name || "", paths: [] });
    mods.get(id).paths.push(item.path);
  }
  if (!mods.size) return "";
  const names = [...mods].map(([id, m]) => `[${luaStr(id)}] = ${luaStr(m.name)}`).join(", ");
  let stamp = `modNames = {${names}}, `;
  if (!/\brequiredMods\s*=/.test(text)) {
    const list = [...mods].map(([id, m]) => `{workshopId = ${luaStr(id)}, modName = ${luaStr(m.name)}, resources = {${m.paths.map(luaStr).join(", ")}}}`).join(", ");
    stamp += `requiredMods = {${list}}, `;
  }
  return stamp;
}

async function stampCommunity(text, row) {
  let out = text.replace(/\b(origin|author|description|version) = (?:"(?:[^"\\]|\\.)*"|\d+|nil)\s*,?\s*/g, "");
  let mods = "";
  try { mods = await modStamp(out, row); } catch (_) { mods = ""; } // names are a nicety: never block a download
  const stamp = `origin = ${row.official ? '"official"' : '"community"'}, version = ${Number(row.version) || 1}, author = ${luaStr(row.author || "anonymous")}, description = ${luaStr(row.description || "")}, ${mods}`;
  out = out.replace(/return\s*\{/, "return {" + stamp);
  return out.replace(/^-- Origin: .*$/m, `-- Origin: ${row.official ? "official" : "community"} | Id: ${row.blueprint_id || "?"} | Version: ${row.version || 1}`);
}
