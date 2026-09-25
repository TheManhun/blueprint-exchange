// Blueprint Exchange -- mod dependency resolution on the upload page.
//
// A blueprint's `requires` block lists resource PATHS (constructions, track,
// street, bridge, tunnel types and signal models). BPX already knows which of
// those ship with the base game; this teaches it WHICH STEAM WORKSHOP MOD
// supplies the rest. The first uploader teaches BPX once (by scanning their
// Workshop folder locally, or by typing the Workshop id); later uploads of
// anything using the same files are recognised automatically.
//
// Privacy: the folder scan runs entirely in the browser and reads file NAMES
// only. Only Workshop ids and resource paths are sent -- never file contents,
// user names, drive paths or the folder's location.
//
// Needs site.js (sb, esc, bpxModsCall, bpxFailText, bpxSteamUrl). The page
// supplies the markup (#depBox ...) and calls bpxDeps.check(requires).

const bpxDeps = (() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n || 0).toLocaleString();

  const GROUPS = [
    ["constructions", "construction", "construction"],
    ["tracks", "track", "track type"],
    ["streets", "street", "street type"],
    ["bridges", "bridge", "bridge type"],
    ["tunnels", "tunnel", "tunnel type"],
    ["models", "model", "model"],
  ];
  // Where a mod keeps each kind of file, under its res/ folder.
  const RES_PREFIX = {
    construction: "construction/", track: "config/track/", street: "config/street/",
    bridge: "config/bridge/", tunnel: "config/tunnel/", model: "models/model/",
  };
  const LABEL = Object.fromEntries(GROUPS.map(([, type, label]) => [type, label]));

  let state = { requires: null, claims: [], report: [], checking: false, error: false };
  const claimMods = new Map(); // workshop id -> Steam-verified mod (looked up once)
  const justLinked = new Set(); // Workshop ids identified during this upload (worded "identified", not "recognised")
  let manual = null; // { mod } while a manually entered mod awaits confirmation
  // Optional full Workshop scan (community contribution). Nothing is sent
  // unless the uploader reviews the report and chooses "Blueprint + Help TFBPX".
  let help = { dismissed: false, stage: "offer", full: null, sent: null, error: null };
  let submitChoice = () => {};
  let onChange = () => {};

  const unresolved = () => state.report.filter((x) => x.status === "unknown");
  const external = () => state.report.filter((x) => x.status !== "base");
  const isResolved = () => !!state.requires && !state.checking && !state.error && unresolved().length === 0;

  // ---- reading the requires block (all groups, whatever order the mod wrote them) ----
  function parseRequires(text) {
    const out = {};
    for (const [group] of GROUPS) {
      const m = String(text).match(new RegExp("requires = \\{(?:\\w+ = \\{[^{}]*\\},\\s*)*" + group + " = \\{([^}]*)\\}"));
      out[group] = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    }
    return out;
  }

  // requiredMods: what the mod recorded at capture time -- which Workshop mod
  // supplied each resource. It is a CLAIM inside an uploaded file, so it is only
  // ever offered as a suggestion for the uploader to confirm (the Workshop item
  // is verified with Steam first); requires stays the real check.
  function parseRequiredMods(text) {
    const out = [];
    const t = String(text);
    const at = t.indexOf("requiredMods = {");
    if (at < 0) return out;
    // balanced-brace slice of the requiredMods table (entries nest one level deep)
    let depth = 0, end = -1;
    for (let i = t.indexOf("{", at); i < t.length && i < at + 60000; i++) {
      const ch = t[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return out;
    const src = t.slice(t.indexOf("{", at) + 1, end);
    const entries = src.match(/\{(?:[^{}]|\{[^{}]*\})*\}/g) || [];
    for (const e of entries.slice(0, 12)) {
      const id = (e.match(/workshopId = "([0-9]{6,12})"/) || [])[1];
      const modio = (e.match(/modioId = "([0-9]{1,10})"/) || [])[1];
      if (!id && !modio) continue; // local mods can't be linked to anything public
      const res = (e.match(/resources = \{([^}]*)\}/) || [, ""])[1];
      const paths = [...res.matchAll(/"([^"]+)"/g)].map((m) => m[1]).slice(0, 100);
      if (!paths.length) continue;
      const name = ((e.match(/modName = "([^"]{1,80})"/) || [, ""])[1]).replace(/[^A-Za-z0-9 _.,:()&'+-]/g, "").trim();
      const url = bpxModioUrl((e.match(/modioUrl = "([^"]+)"/) || [])[1]);
      // a mod on BOTH stores is linked through Steam (checkable); mod.io-only ones are taken as recorded
      out.push({ workshopId: id || null, modioId: modio || null, modName: name, modioUrl: url, resources: paths });
    }
    return out;
  }

  // ---- status + lists ----
  function setStatus(kind, text) {
    const el = $("depStatus");
    el.classList.toggle("ok", kind === "ok");
    el.classList.toggle("warn", kind === "warn");
    el.classList.toggle("bad", kind === "bad");
    el.querySelector(".txt").textContent = text;
  }

  function render() {
    const list = $("depList"), actions = $("depActions");
    list.innerHTML = "";
    actions.hidden = true;
    if (!state.requires) {
      setStatus("idle", "Dependencies are checked once your blueprint passes inspection");
      hidePanels();
      renderHelp();
      return;
    }
    if (state.checking) { setStatus("idle", "Checking dependencies\u2026"); return; }
    if (state.error) {
      setStatus("bad", "Couldn't check dependencies just now.");
      list.innerHTML = '<p class="hint">Please try again in a moment. <button type="button" class="linkbtn" id="depRetry">Check again</button></p>';
      $("depRetry").addEventListener("click", () => check(state.requires, state.claims));
      return;
    }
    const ext = external();
    const unres = unresolved();
    if (ext.length === 0) {
      setStatus("ok", "\u2713 No external mod dependencies detected.");
      hidePanels();
      renderHelp();
      return;
    }
    // resolved externals, grouped by Workshop mod
    const byMod = new Map();
    for (const x of ext.filter((y) => y.status === "mod" && y.mod)) {
      const id = x.mod.platform === "modio" ? "modio:" + x.mod.modio_id : String(x.mod.workshop_id);
      if (!byMod.has(id)) byMod.set(id, { mod: x.mod, paths: [] });
      byMod.get(id).paths.push(x.path);
    }
    let html = "";
    for (const [id, g] of byMod) {
      const link = bpxModLink(g.mod);
      const url = link ? link.url : null;
      const isModio = g.mod.platform === "modio";
      const pv = g.mod.preview_url;
      const img = typeof pv === "string" && pv.startsWith("https://")
        ? `<img src="${esc(pv)}" alt="" width="96" height="54" referrerpolicy="no-referrer" loading="lazy">` : "";
      html += `<div class="depitem ok"><p class="depkind">${justLinked.has(id) ? "\u2713 Required mod identified" : "\u2713 Required mod recognised"}</p>
        <div class="depmod">${img}<div><div class="t">${esc(g.mod.name)}</div><div class="hint">${isModio ? "mod.io #" + esc(g.mod.modio_id) : "Workshop #" + esc(id)}</div>
        ${url ? `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${link.label}</a>` : ""}</div></div>
        <div class="hint">Provides: ${g.paths.map((p) => `<code>${esc(p)}</code>`).join(", ")}</div></div>`;
    }
    if (unres.length) {
      const byType = {};
      unres.forEach((x) => { (byType[x.type] = byType[x.type] || []).push(x.path); });
      html += `<div class="depitem warn"><p class="depkind">External mod content detected.</p>
        <ul>${Object.entries(byType).map(([type, paths]) => paths.map((p) => `<li>External ${esc(LABEL[type] || type)}: <code>${esc(p)}</code></li>`).join("")).join("")}</ul>
        <p>BPX needs to know which Steam Workshop mod provides this content so other players can install everything required by your blueprint.</p></div>`;
      setStatus("warn", "External mod content detected.");
      actions.hidden = false;
    } else {
      setStatus("ok", "\u2713 All external mod content is identified.");
      hidePanels();
    }
    list.innerHTML = html;
    renderHelp();
    renderSuggest();
  }

  // ---- optional full scan of the Workshop folder ----
  const FULL_RX = /(?:^|\/)([0-9]{6,12})\/res\/(.+)$/;
  const FULL_KINDS = [
    ["construction/", ".con", "construction"], ["config/street/", ".lua", "street"], ["config/track/", ".lua", "track"],
    ["config/bridge/", ".lua", "bridge"], ["config/tunnel/", ".lua", "tunnel"], ["models/model/", ".mdl", "model"],
  ];
  const SAFE_PATH = /^[A-Za-z0-9_./ -]{1,200}$/;
  const FULL_PER_MOD = 400, FULL_TOTAL = 4000;

  function classifyFile(rest) {
    const lc = rest.toLowerCase();
    for (const [prefix, ext, type] of FULL_KINDS) {
      if (!lc.startsWith(prefix) || !lc.endsWith(ext)) continue;
      const path = rest.slice(prefix.length);
      // "if BPX can capture it as part of a layout, it is relevant": constructions and
      // road/track/bridge/tunnel types, plus signal models. Other models are props inside
      // constructions, not things a blueprint lists.
      if (type === "model" && !/signal/i.test(path)) return null;
      return SAFE_PATH.test(path) ? { type, path } : null;
    }
    return null;
  }

  async function fullScan(fileList) {
    help.stage = "scanning"; help.error = null; renderHelp();
    const seen = new Set();
    const index = new Map(); // workshop id -> [{type, path}]
    let total = 0;
    for (let i = 0; i < fileList.length; i++) {
      const m = FULL_RX.exec(fileList[i].webkitRelativePath || "");
      if (m) {
        seen.add(m[1]);
        const r = classifyFile(m[2]);
        if (r && total < FULL_TOTAL) {
          const list = index.get(m[1]) || [];
          if (list.length < FULL_PER_MOD) { list.push(r); index.set(m[1], list); total++; }
        }
      }
      if (i % 20000 === 19999) await new Promise((res) => setTimeout(res));
    }
    // which of these does BPX already know (base game or any mod)?
    const flat = [];
    for (const [id, list] of index) list.forEach((r) => flat.push({ id, ...r }));
    const known = new Set();
    let failed = false;
    for (let i = 0; i < flat.length; i += 500) {
      const chunk = flat.slice(i, i + 500).map((x) => ({ type: x.type, path: x.path }));
      try {
        const { data, error } = await sb.rpc("bp_known_resources", { p_items: chunk });
        if (error || !Array.isArray(data)) { failed = true; break; }
        data.forEach((k) => known.add(k));
      } catch (e) { failed = true; break; }
    }
    if (failed) { help.stage = "offer"; help.error = "Couldn't compare the scan with the library just now. Please try again in a moment."; renderHelp(); return; }
    const fresh = new Map();
    let freshCount = 0;
    for (const x of flat) {
      if (known.has(x.type + ":" + x.path)) continue;
      if (!fresh.has(x.id)) fresh.set(x.id, []);
      fresh.get(x.id).push({ type: x.type, path: x.path });
      freshCount++;
    }
    help.full = { scanned: seen.size, relevant: index.size, found: flat.length, known: flat.length - freshCount, fresh, freshCount, review: false };
    help.stage = "report";
    renderHelp();
  }

  function renderHelp() {
    const box = $("depHelp");
    const show = isResolved() && external().length > 0 && !help.dismissed;
    box.hidden = !show;
    if (!show) { box.innerHTML = ""; return; }
    const f = help.full;
    let html = "";
    if (help.stage === "offer" || help.stage === "scanning") {
      html = `<p class="depkind">Help improve BPX mod detection</p>
        <p>BPX can scan the rest of your Transport Fever 2 Workshop folder for blueprint-relevant assets and help build the dependency database for future users.</p>
        <p><strong>Your privacy, your control.</strong><br>The scan runs locally and is limited to your Transport Fever 2 Workshop folder.<br>Nothing extra is submitted automatically.<br>You will be shown a full report before deciding whether to contribute additional dependency data.</p>
        ${help.error ? `<p class="msg bad" style="display:block">${esc(help.error)}</p>` : ""}
        ${help.stage === "scanning" ? '<p class="hint">Scanning file names on your computer\u2026</p>'
          : '<div class="row"><label class="btn primary" for="depFullFolder" style="cursor:pointer">Scan My Workshop Mods</label><button type="button" data-act="no">No Thanks</button></div>'}`;
    } else if (help.stage === "report" && f) {
      const names = mods().map((m) => esc(m.name)).join(", ");
      html = `<p class="depkind">Scan complete \u2014 nothing extra has been submitted yet.</p>
        <ul class="depsummary">
          <li>${fmt(f.scanned)} Workshop mod${f.scanned === 1 ? "" : "s"} scanned</li>
          <li>${fmt(f.relevant)} contain BPX-relevant assets</li>
          <li>${fmt(f.found)} resource mapping${f.found === 1 ? "" : "s"} found</li>
          <li>${fmt(f.known)} already known</li>
          <li>${fmt(f.freshCount)} new mapping${f.freshCount === 1 ? "" : "s"} available</li>
        </ul>
        ${f.freshCount ? `<div class="row"><button type="button" data-act="review">${f.review ? "Hide Full Scan Data" : "Review Full Scan Data"}</button></div>` : ""}
        ${f.review ? reviewHtml(f) : ""}
        <p><strong>Required for this blueprint:</strong><br>\u2713 ${names || "your mods"} identified</p>
        ${f.freshCount ? `<p><strong>Optional community contribution:</strong><br>${fmt(f.freshCount)} additional resource mapping${f.freshCount === 1 ? "" : "s"} could help future BPX users.</p>
        <div class="row"><button type="button" class="primary" data-act="only">Submit Blueprint Only</button><button type="button" data-act="plus">Submit Blueprint + Help TFBPX</button></div>
        <p class="hint">Blueprint Only sends just what this blueprint needs. Help TFBPX also sends the new mappings listed in the review: Workshop ID, resource type and resource path \u2014 nothing else.</p>` : '<p class="hint">Everything in your folder is already known to BPX \u2014 thank you for checking!</p>'}`;
    } else if (help.stage === "sent") {
      html = `<p class="depkind">${help.error ? "Thank you \u2014 part of the scan was shared" : "Thank you for helping TFBPX!"}</p><p>${esc(help.sent || "")}</p>${help.error ? `<p class="hint">${esc(help.error)}</p>` : ""}`;
    }
    box.innerHTML = html;
  }

  // Exactly what would be sent (grouped by Workshop id; the name is looked up from Steam on submit).
  function reviewHtml(f) {
    const rows = [...f.fresh].slice(0, 200).map(([id, list]) =>
      `<details class="depreview"><summary>Workshop #${esc(id)} \u2014 ${list.length} new</summary><ul>${list.slice(0, 200).map((r) => `<li>${esc(r.type)}: <code>${esc(r.path)}</code></li>`).join("")}${list.length > 200 ? `<li class="hint">\u2026and ${list.length - 200} more</li>` : ""}</ul></details>`).join("");
    return `<div class="depitem"><p class="depkind">This is exactly what would be sent</p>${rows}${f.fresh.size > 200 ? `<p class="hint">\u2026and ${f.fresh.size - 200} more mods</p>` : ""}<p class="hint">Only Workshop IDs, resource types and resource paths. No file contents, no folder locations, no account or user names.</p></div>`;
  }

  // Send the approved new mappings (called right after the blueprint uploaded).
  async function contribute() {
    const f = help.full;
    if (!f || !f.freshCount) return { ok: true, message: "" };
    const all = [...f.fresh].map(([id, resources]) => ({ workshopId: id, resources }));
    const chunks = []; let cur = [], n = 0;
    for (const m of all) {
      if (cur.length && (cur.length >= 60 || n + m.resources.length > 3000)) { chunks.push(cur); cur = []; n = 0; }
      cur.push(m); n += m.resources.length;
    }
    if (cur.length) chunks.push(cur);
    let mappings = 0, modsCount = 0, err = null;
    for (const chunk of chunks.slice(0, 3)) {
      const r = await bpxModsCall({ action: "bulk_link", mods: chunk });
      if (!r || !r.ok) { err = bpxFailText(r); break; }
      mappings += r.resourcesLinked || 0; modsCount += r.modsLinked || 0;
    }
    if (chunks.length > 3 && !err) err = "Your scan was large, so only part of it was shared today.";
    help.stage = "sent"; help.error = err;
    help.sent = `${fmt(mappings)} new resource mapping${mappings === 1 ? "" : "s"} shared for ${fmt(modsCount)} Workshop mod${modsCount === 1 ? "" : "s"}.`;
    return { ok: !err, message: help.sent, error: err };
  }

  function mods() {
    const seen = new Map();
    state.report.filter((x) => x.status === "mod" && x.mod).forEach((x) => seen.set(String(x.mod.workshop_id), { workshop_id: String(x.mod.workshop_id), name: x.mod.name }));
    return [...seen.values()];
  }

  // The blueprint's own claims that cover something still unidentified.
  function openClaims() {
    const unresolvedPaths = new Set(unresolved().map((x) => x.type + ":" + x.path));
    const typeOf = {};
    unresolved().forEach((x) => { typeOf[x.path] = x.type; });
    const out = [];
    for (const c of state.claims || []) {
      const items = c.resources.filter((p) => typeOf[p] && unresolvedPaths.has(typeOf[p] + ":" + p)).map((p) => ({ type: typeOf[p], path: p }));
      if (items.length) out.push({ key: c.workshopId ? c.workshopId : "modio:" + c.modioId, workshopId: c.workshopId, modioId: c.modioId, modName: c.modName, modioUrl: c.modioUrl, items });
    }
    return out;
  }

  async function renderSuggest() {
    const box = $("depSuggest");
    const claims = state.error || state.checking ? [] : openClaims();
    if (!claims.length) { box.innerHTML = ""; return; }
    // verify each claimed Workshop item with Steam once (also checks it is a Transport Fever 2 mod)
    for (const c of claims.slice(0, 4)) {
      if (c.workshopId && !claimMods.has(c.workshopId)) {
        const r = await bpxModsCall({ action: "lookup", workshopId: c.workshopId });
        claimMods.set(c.workshopId, r && r.ok ? r.mod : null);
      }
    }
    if (state.requires === null || state.checking) return;
    box.innerHTML = claims.slice(0, 4).map((c) => {
      const provides = `<p>Provides: ${c.items.map((x) => `<code>${esc(x.path)}</code>`).join(", ")}</p>`;
      if (c.workshopId) {
        const mod = claimMods.get(c.workshopId);
        if (!mod) return "";
        return modCard(mod, "This blueprint says it needs this mod") + provides +
          `<div class="row"><button type="button" class="primary" data-claim="${esc(c.key)}">Yes, link this mod</button></div>
           <div class="msg" data-claimmsg="${esc(c.key)}" role="status"></div>`;
      }
      // mod.io only: BPX cannot check these with mod.io, so it shows exactly what the uploader's own
      // mod.io installation recorded and asks them to confirm
      const url = bpxModioUrl(c.modioUrl);
      return `<div class="depitem ok"><p class="depkind">This blueprint says it needs this mod.io mod</p>
        <div class="t">${esc(c.modName || "mod.io mod")}</div><div class="hint">mod.io #${esc(c.modioId)}${url ? "" : ""}</div>
        ${url ? `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View on mod.io</a>` : ""}
        <p class="hint">Recorded by the mod.io installation on the computer that captured this blueprint. BPX can't check mod.io mods itself, so please confirm it is the right one.</p></div>` + provides +
        `<div class="row"><button type="button" class="primary" data-claim="${esc(c.key)}">Yes, link this mod</button></div>
         <div class="msg" data-claimmsg="${esc(c.key)}" role="status"></div>`;
    }).join("");
  }

  async function confirmClaim(key) {
    const c = openClaims().find((x) => x.key === key);
    const msg = document.querySelector(`[data-claimmsg="${key}"]`);
    if (!c) return;
    const fail = (text) => { if (msg) { msg.className = "msg bad"; msg.textContent = text; } };
    if (c.workshopId) {
      const link = await bpxModsCall({ action: "link", workshopId: c.workshopId, source: "manual", resources: c.items });
      if (!link || !link.ok) { fail(bpxFailText(link)); return; }
      justLinked.add(String(c.workshopId));
    } else {
      let linked = 0;
      try {
        const { data, error } = await sb.rpc("bp_link_modio", { p_modio_id: Number(c.modioId), p_name: c.modName || "mod.io mod", p_url: bpxModioUrl(c.modioUrl), p_resources: c.items });
        linked = error ? 0 : Number(data) || 0;
      } catch (e) { linked = 0; }
      if (!linked) { fail("Couldn't save that just now. Please try again in a moment."); return; }
      justLinked.add("modio:" + c.modioId);
    }
    await check(state.requires, state.claims);
  }

  function hidePanels() {
    $("depScan").hidden = true;
    $("depManual").hidden = true;
  }

  // ---- asking the library ----
  async function check(requires, claims) {
    state = { requires, claims: claims || (state.requires === requires ? state.claims : []), report: [], checking: true, error: false };
    manual = null;
    render();
    onChange();
    let report = null;
    try {
      const { data, error } = await sb.rpc("bp_dependency_report", { p_requires: requires });
      if (!error && Array.isArray(data)) report = data;
    } catch (e) { /* fall through */ }
    if (state.requires !== requires) return; // a different file was chosen meanwhile
    state.checking = false;
    if (report) state.report = report; else state.error = true;
    render();
    onChange();
  }

  function reset() {
    state = { requires: null, claims: [], report: [], checking: false, error: false };
    $("depSuggest").innerHTML = "";
    justLinked.clear();
    manual = null;
    help = { dismissed: false, stage: "offer", full: null, sent: null, error: null };
    hidePanels();
    $("depScanOut").innerHTML = "";
    $("depManualOut").innerHTML = "";
    render();
    onChange();
  }

  // ---- option 1: quick scan of the Workshop folder ----
  function wantedFiles() {
    const map = new Map(); // lowercase "res/..." tail -> { type, path }
    for (const x of unresolved()) {
      const prefix = RES_PREFIX[x.type];
      if (prefix) map.set((prefix + x.path).toLowerCase(), { type: x.type, path: x.path });
    }
    return map;
  }

  async function scan(fileList) {
    const out = $("depScanOut");
    const wanted = wantedFiles();
    if (!wanted.size) return;
    out.innerHTML = '<p class="hint">Searching\u2026</p>';
    // Only immediate Workshop item folders are considered: <id>/res/<kind>/<path>.
    // Only file NAMES are read, and only on this computer.
    const found = new Map(); // wanted key -> Set(workshop ids)
    const total = fileList.length;
    let remaining = wanted.size;
    for (let i = 0; i < total; i++) {
      const rel = fileList[i].webkitRelativePath || "";
      const m = /(?:^|\/)([0-9]{6,12})\/res\/(.+)$/.exec(rel);
      if (m) {
        const key = m[2].toLowerCase();
        if (wanted.has(key)) {
          if (!found.has(key)) { found.set(key, new Set()); remaining--; }
          found.get(key).add(m[1]);
        }
      }
      if (i % 20000 === 19999) await new Promise((r) => setTimeout(r));
      // stop once everything this blueprint needs has been found (a few extra
      // files from the same mod are not needed)
      if (remaining === 0) break;
    }
    if (found.size === 0) {
      out.innerHTML = `<p class="msg bad" style="display:block">BPX couldn't find that content in the folder you chose. Check it is <code>steamapps\\workshop\\content\\1066780</code> and that the mod is subscribed, or enter the Workshop ID manually.</p>`;
      return;
    }
    // group the found files by Workshop id
    const byId = new Map();
    for (const [key, ids] of found) {
      const w = wanted.get(key);
      for (const id of ids) {
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push({ type: w.type, path: w.path });
      }
    }
    const ids = [...byId.keys()].slice(0, 6);
    let html = "";
    let linkedAny = false;
    for (const id of ids) {
      const look = await bpxModsCall({ action: "lookup", workshopId: id });
      if (!look || !look.ok) {
        html += `<div class="depitem warn"><p class="depkind">Found in Workshop #${esc(id)}</p><p>${esc(bpxFailText(look))}</p></div>`;
        continue;
      }
      const link = await bpxModsCall({ action: "link", workshopId: id, source: "scan", resources: byId.get(id) });
      if (!link || !link.ok) {
        html += `<div class="depitem warn"><p class="depkind">${esc(look.mod.title)} (Workshop #${esc(id)})</p><p>${esc(bpxFailText(link))}</p></div>`;
        continue;
      }
      linkedAny = true;
      justLinked.add(String(id));
    }
    // anything not found in the chosen folder
    const missing = [...wanted].filter(([key]) => !found.has(key)).map(([, w]) => w.path);
    if (missing.length) html += `<p class="hint">Not found in that folder: ${missing.map((p) => `<code>${esc(p)}</code>`).join(", ")}</p>`;
    out.innerHTML = html;
    if (linkedAny) await check(state.requires, state.claims);
  }

  function modCard(mod, heading) {
    const url = bpxSteamUrl(mod.workshopId);
    const img = typeof mod.previewUrl === "string" && mod.previewUrl.startsWith("https://")
      ? `<img src="${esc(mod.previewUrl)}" alt="" width="96" height="54" referrerpolicy="no-referrer" loading="lazy">` : "";
    return `<div class="depitem ok"><p class="depkind">${esc(heading)}</p><div class="depmod">${img}<div>
      <div class="t">${esc(mod.title)}</div><div class="hint">Workshop #${esc(mod.workshopId)}${mod.author ? " \u00b7 by " + esc(mod.author) : ""}</div>
      ${url ? `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View on Steam Workshop</a>` : ""}</div></div></div>`;
  }

  // ---- option 2: Workshop id typed by the uploader ----
  async function manualFind() {
    const out = $("depManualOut");
    const id = $("depModId").value.trim();
    manual = null;
    if (!/^[0-9]{6,12}$/.test(id)) {
      out.innerHTML = '<p class="msg bad" style="display:block">Enter just the Workshop item number: digits only, no link.</p>';
      return;
    }
    out.innerHTML = '<p class="hint">Looking it up on Steam\u2026</p>';
    $("depModFind").disabled = true;
    const r = await bpxModsCall({ action: "lookup", workshopId: id });
    $("depModFind").disabled = false;
    if (!r || !r.ok) { out.innerHTML = `<p class="msg bad" style="display:block">${esc(bpxFailText(r))}</p>`; return; }
    manual = { mod: r.mod };
    const unres = unresolved();
    out.innerHTML = modCard(r.mod, "Is this the mod?") +
      `<p><strong>Does this mod provide the external content detected in your blueprint?</strong></p>
       <ul class="depchecks">${unres.map((x, i) => `<li><input type="checkbox" id="depChk${i}" data-i="${i}" checked><label for="depChk${i}" style="margin:0;font-weight:500">External ${esc(LABEL[x.type] || x.type)}: <code>${esc(x.path)}</code></label></li>`).join("")}</ul>
       <div class="row"><button type="button" class="primary" id="depYes">Yes, link this mod</button><button type="button" id="depNo">Cancel</button></div>
       <div class="msg" id="depManualMsg" role="status"></div>`;
    $("depNo").addEventListener("click", () => { manual = null; out.innerHTML = ""; $("depModId").value = ""; });
    $("depYes").addEventListener("click", async () => {
      const chosen = unres.filter((_, i) => $("depChk" + i) && $("depChk" + i).checked).map((x) => ({ type: x.type, path: x.path }));
      const msg = $("depManualMsg");
      if (!chosen.length) { msg.className = "msg bad"; msg.textContent = "Tick at least one item this mod provides."; return; }
      $("depYes").disabled = true;
      const link = await bpxModsCall({ action: "link", workshopId: manual.mod.workshopId, source: "manual", resources: chosen });
      if (!link || !link.ok) { msg.className = "msg bad"; msg.textContent = bpxFailText(link); $("depYes").disabled = false; return; }
      out.innerHTML = "";
      $("depModId").value = "";
      justLinked.add(String(manual.mod.workshopId));
      manual = null;
      await check(state.requires, state.claims);
    });
  }

  // ---- wiring ----
  function init() {
    $("depFindBtn").addEventListener("click", () => {
      $("depManual").hidden = true;
      $("depScan").hidden = !$("depScan").hidden;
    });
    $("depManualBtn").addEventListener("click", () => {
      $("depScan").hidden = true;
      $("depManual").hidden = !$("depManual").hidden;
    });
    $("depFolder").addEventListener("change", (e) => {
      const files = e.target.files;
      if (files && files.length) scan(files).finally(() => { e.target.value = ""; });
    });
    $("depFullFolder").addEventListener("change", (e) => {
      const files = e.target.files;
      if (files && files.length) fullScan(files).finally(() => { e.target.value = ""; });
    });
    $("depHelp").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "no") { help.dismissed = true; renderHelp(); }
      else if (act === "review" && help.full) { help.full.review = !help.full.review; renderHelp(); }
      else if (act === "only") submitChoice(false);
      else if (act === "plus") submitChoice(true);
    });
    $("depSuggest").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-claim]");
      if (btn) { btn.disabled = true; confirmClaim(btn.dataset.claim); }
    });
    $("depModFind").addEventListener("click", manualFind);
    $("depModId").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); manualFind(); } });
    render();
  }

  return {
    init, check, reset, parseRequires, parseRequiredMods, isResolved,
    set onChange(fn) { onChange = fn; },
    isChecking: () => state.checking,
    contribute,
    hasContribution: () => !!(help.full && help.full.freshCount),
    set onSubmitChoice(fn) { submitChoice = fn; },
    // for the live preview card
    mods,
    unresolvedPaths: () => unresolved().map((x) => x.path),
  };
})();
