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

  let state = { requires: null, report: [], checking: false, error: false };
  const justLinked = new Set(); // Workshop ids identified during this upload (worded "identified", not "recognised")
  let manual = null; // { mod } while a manually entered mod awaits confirmation
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
      return;
    }
    if (state.checking) { setStatus("idle", "Checking dependencies…"); return; }
    if (state.error) {
      setStatus("bad", "Couldn't check dependencies just now.");
      list.innerHTML = '<p class="hint">Please try again in a moment. <button type="button" class="linkbtn" id="depRetry">Check again</button></p>';
      $("depRetry").addEventListener("click", () => check(state.requires));
      return;
    }
    const ext = external();
    const unres = unresolved();
    if (ext.length === 0) {
      setStatus("ok", "✓ No external mod dependencies detected.");
      hidePanels();
      return;
    }
    // resolved externals, grouped by Workshop mod
    const byMod = new Map();
    for (const x of ext.filter((y) => y.status === "mod" && y.mod)) {
      const id = String(x.mod.workshop_id);
      if (!byMod.has(id)) byMod.set(id, { mod: x.mod, paths: [] });
      byMod.get(id).paths.push(x.path);
    }
    let html = "";
    for (const [id, g] of byMod) {
      const url = bpxSteamUrl(id);
      const pv = g.mod.preview_url;
      const img = typeof pv === "string" && pv.startsWith("https://")
        ? `<img src="${esc(pv)}" alt="" width="96" height="54" referrerpolicy="no-referrer" loading="lazy">` : "";
      html += `<div class="depitem ok"><p class="depkind">${justLinked.has(id) ? "✓ Required mod identified" : "✓ Required mod recognised"}</p>
        <div class="depmod">${img}<div><div class="t">${esc(g.mod.name)}</div><div class="hint">Workshop #${esc(id)}</div>
        ${url ? `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View on Steam Workshop</a>` : ""}</div></div>
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
      setStatus("ok", "✓ All external mod content is identified.");
      hidePanels();
    }
    list.innerHTML = html;
  }

  function hidePanels() {
    $("depScan").hidden = true;
    $("depManual").hidden = true;
  }

  // ---- asking the library ----
  async function check(requires) {
    state = { requires, report: [], checking: true, error: false };
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
    state = { requires: null, report: [], checking: false, error: false };
    justLinked.clear();
    manual = null;
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
    out.innerHTML = '<p class="hint">Searching…</p>';
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
    if (linkedAny) await check(state.requires);
  }

  function modCard(mod, heading) {
    const url = bpxSteamUrl(mod.workshopId);
    const img = typeof mod.previewUrl === "string" && mod.previewUrl.startsWith("https://")
      ? `<img src="${esc(mod.previewUrl)}" alt="" width="96" height="54" referrerpolicy="no-referrer" loading="lazy">` : "";
    return `<div class="depitem ok"><p class="depkind">${esc(heading)}</p><div class="depmod">${img}<div>
      <div class="t">${esc(mod.title)}</div><div class="hint">Workshop #${esc(mod.workshopId)}${mod.author ? " · by " + esc(mod.author) : ""}</div>
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
    out.innerHTML = '<p class="hint">Looking it up on Steam…</p>';
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
      await check(state.requires);
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
    $("depModFind").addEventListener("click", manualFind);
    $("depModId").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); manualFind(); } });
    render();
  }

  return {
    init, check, reset, parseRequires, isResolved,
    set onChange(fn) { onChange = fn; },
    isChecking: () => state.checking,
    // for the live preview card
    mods: () => {
      const seen = new Map();
      state.report.filter((x) => x.status === "mod" && x.mod).forEach((x) => seen.set(String(x.mod.workshop_id), { workshop_id: String(x.mod.workshop_id), name: x.mod.name }));
      return [...seen.values()];
    },
    unresolvedPaths: () => unresolved().map((x) => x.path),
  };
})();
