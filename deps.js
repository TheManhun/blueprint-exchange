// Blueprint Exchange -- the "Required mods" panel on the upload page.
//
// A blueprint's `requires` block lists resource PATHS (constructions, track,
// street, bridge, tunnel types and signal models). BPX knows which of those
// ship with the base game. For the rest it needs to know WHICH mod supplies
// them -- a Steam Workshop mod or a mod.io mod -- so other players know what to
// install. A blueprint captured by the current mod says so itself
// (`requiredMods`, recorded from the player's own installs); the panel shows
// those mods, and pressing Upload attaches them. Older blueprints without that
// record fall back to typing the Workshop ID.
//
// Nothing here reads the player's folders; only Workshop ids, mod.io ids and
// resource paths are ever sent.
//
// Needs site.js (sb, esc, bpxModsCall, bpxFailText, bpxSteamUrl, bpxModioUrl,
// bpxModLink). The page supplies the markup (#depBox ...) and calls
// bpxDeps.check(requires, claims).

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
  const LABEL = Object.fromEntries(GROUPS.map(([, type, label]) => [type, label]));

  let state = { requires: null, claims: [], report: [], checking: false, error: false };
  const claimMods = new Map(); // workshop id -> Steam-verified mod (or null), looked up once
  const justLinked = new Set(); // keys attached during this upload
  let manual = null;
  let onChange = () => {};

  const unresolved = () => state.report.filter((x) => x.status === "unknown");
  const external = () => state.report.filter((x) => x.status !== "base");

  // ---- reading the file (data only, never executed) ----
  function parseRequires(text) {
    const out = {};
    for (const [group] of GROUPS) {
      const m = String(text).match(new RegExp("requires = \\{(?:\\w+ = \\{[^{}]*\\},\\s*)*" + group + " = \\{([^}]*)\\}"));
      out[group] = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    }
    return out;
  }

  // requiredMods: what the mod recorded at capture time about which mod supplies each file.
  // It is a CLAIM inside an uploaded file: Steam ones are checked with Steam, mod.io ones are
  // shown exactly as recorded, and `requires` stays the real check.
  function parseRequiredMods(text) {
    const out = [];
    const t = String(text);
    const at = t.indexOf("requiredMods = {");
    if (at < 0) return out;
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

  // ---- what the blueprint's own claims cover ----
  // { key, workshopId, modioId, modName, modioUrl, items:[{type,path}], mod (Steam-verified, when known) }
  function claimsForUnresolved() {
    const typeOf = {};
    unresolved().forEach((x) => { typeOf[x.path] = x.type; });
    const out = [];
    for (const c of state.claims || []) {
      const items = c.resources.filter((p) => typeOf[p]).map((p) => ({ type: typeOf[p], path: p }));
      if (!items.length) continue;
      out.push({ key: c.workshopId ? c.workshopId : "modio:" + c.modioId, workshopId: c.workshopId, modioId: c.modioId, modName: c.modName, modioUrl: c.modioUrl, items, mod: c.workshopId ? claimMods.get(c.workshopId) : null });
    }
    return out;
  }

  // A claim can be attached when Steam confirmed the item, or (mod.io) it is well-formed.
  const claimUsable = (c) => c.workshopId ? !!c.mod : !!c.modioId;

  function uncovered() {
    const covered = new Set();
    claimsForUnresolved().filter(claimUsable).forEach((c) => c.items.forEach((x) => covered.add(x.type + ":" + x.path)));
    return unresolved().filter((x) => !covered.has(x.type + ":" + x.path));
  }

  const isReady = () => !!state.requires && !state.checking && !state.error && uncovered().length === 0;

  // ---- drawing ----
  function setStatus(kind, text) {
    const el = $("depStatus");
    el.classList.toggle("ok", kind === "ok");
    el.classList.toggle("warn", kind === "warn");
    el.classList.toggle("bad", kind === "bad");
    el.querySelector(".txt").textContent = text;
  }

  function modCard(mod, heading) {
    const url = bpxSteamUrl(mod.workshopId);
    const img = typeof mod.previewUrl === "string" && mod.previewUrl.startsWith("https://")
      ? `<img src="${esc(mod.previewUrl)}" alt="" width="96" height="54" referrerpolicy="no-referrer" loading="lazy">` : "";
    return `<div class="depitem ok"><p class="depkind">${esc(heading)}</p><div class="depmod">${img}<div>
      <div class="t">${esc(mod.title)}</div><div class="hint">Workshop #${esc(mod.workshopId)}${mod.author ? " · by " + esc(mod.author) : ""}</div>
      ${url ? `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View on Steam Workshop</a>` : ""}</div></div></div>`;
  }

  // one row per mod: name, where it is, link, and what of the blueprint it supplies
  function modRow(title, sub, link, provides, tag) {
    return `<div class="reqmod"><div class="reqmod-main"><div class="t">${esc(title)}</div><div class="hint">${sub}</div></div>
      <div class="reqmod-side">${tag ? `<span class="reqtag">${esc(tag)}</span>` : ""}${link ? `<a class="btn small" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${link.label}</a>` : ""}</div>
      <div class="hint reqmod-files">Provides: ${provides.map((p) => `<code>${esc(p)}</code>`).join(", ")}</div></div>`;
  }

  function render() {
    const list = $("depList"), manualBox = $("depManual");
    list.innerHTML = "";
    manualBox.hidden = true;
    if (!state.requires) {
      setStatus("idle", "Choose a blueprint file and BPX lists the mods it needs");
      $("depSuggest").innerHTML = "";
      return;
    }
    if (state.checking) { setStatus("idle", "Checking which mods this blueprint needs…"); return; }
    if (state.error) {
      setStatus("bad", "Couldn't check the mods just now.");
      list.innerHTML = '<p class="hint">Please try again in a moment. <button type="button" class="linkbtn" id="depRetry">Check again</button></p>';
      $("depRetry").addEventListener("click", () => check(state.requires, state.claims));
      return;
    }
    if (external().length === 0) {
      setStatus("ok", "✓ No extra mods needed — this blueprint only uses base game content.");
      $("depSuggest").innerHTML = "";
      return;
    }

    // mods already known to the library
    const rows = [];
    const byMod = new Map();
    for (const x of external().filter((y) => y.status === "mod" && y.mod)) {
      const id = x.mod.platform === "modio" ? "modio:" + x.mod.modio_id : String(x.mod.workshop_id);
      if (!byMod.has(id)) byMod.set(id, { mod: x.mod, paths: [] });
      byMod.get(id).paths.push(x.path);
    }
    for (const [id, g] of byMod) {
      const isModio = g.mod.platform === "modio";
      rows.push(modRow(g.mod.name, isModio ? "mod.io #" + esc(g.mod.modio_id) : "Steam Workshop #" + esc(id), bpxModLink(g.mod), g.paths, justLinked.has(id) ? "Attached" : "Known"));
    }
    // mods the blueprint itself names -- attached when Upload is pressed
    const claims = claimsForUnresolved();
    for (const c of claims) {
      if (c.workshopId) {
        if (!c.mod) continue; // not a Transport Fever 2 Workshop item (or Steam is unreachable): not offered
        rows.push(modRow(c.mod.title, "Steam Workshop #" + esc(c.workshopId) + (c.mod.author ? " · by " + esc(c.mod.author) : ""), { url: bpxSteamUrl(c.workshopId), label: "View on Steam Workshop" }, c.items.map((x) => x.path), "Recorded by your game"));
      } else {
        const u = bpxModioUrl(c.modioUrl);
        rows.push(modRow(c.modName || "mod.io mod", "mod.io #" + esc(c.modioId), u ? { url: u, label: "View on mod.io" } : null, c.items.map((x) => x.path), "Recorded by your game"));
      }
    }
    list.innerHTML = rows.length ? `<div class="reqmods">${rows.join("")}</div>` : "";

    const missing = uncovered();
    if (missing.length === 0) {
      const n = rows.length;
      setStatus("ok", `✓ ${n} mod${n === 1 ? "" : "s"} needed — attached to your blueprint when you upload.`);
      const hasModio = claims.some((c) => !c.workshopId);
      $("depSuggest").innerHTML = hasModio ? '<p class="hint">mod.io mods are shown exactly as your own mod.io install recorded them &mdash; BPX can&rsquo;t check them with mod.io, so glance at the name before you upload.</p>' : "";
    } else {
      $("depSuggest").innerHTML = "";
      setStatus("warn", "BPX can't tell which mod provides some of this content.");
      const byType = {};
      missing.forEach((x) => { (byType[x.type] = byType[x.type] || []).push(x.path); });
      list.innerHTML += `<div class="depitem warn"><p class="depkind">Which mod is this from?</p>
        <ul>${Object.entries(byType).map(([type, paths]) => paths.map((p) => `<li>${esc(LABEL[type] || type)}: <code>${esc(p)}</code></li>`).join("")).join("")}</ul>
        <p>Blueprints captured with the current mod name their mods automatically. This one doesn&rsquo;t, so tell BPX which Steam Workshop mod supplies it &mdash; then other players will know what to install.</p></div>`;
      manualBox.hidden = false;
    }

    // look each named Steam mod up once (checks it is a Transport Fever 2 mod), then redraw
    const todo = claims.filter((c) => c.workshopId && !claimMods.has(c.workshopId)).slice(0, 4);
    if (todo.length) {
      Promise.all(todo.map(async (c) => {
        const r = await bpxModsCall({ action: "lookup", workshopId: c.workshopId });
        claimMods.set(c.workshopId, r && r.ok ? r.mod : null);
      })).then(() => { if (state.requires && !state.checking) { render(); onChange(); } });
    }
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
    justLinked.clear();
    manual = null;
    $("depManualOut").innerHTML = "";
    render();
    onChange();
  }

  // ---- pressing Upload: attach the mods the blueprint names ----
  // Resolves { ok } or { ok:false, error }. Only what the panel showed is linked.
  async function applyClaims() {
    const pending = claimsForUnresolved().filter(claimUsable);
    for (const c of pending) {
      if (c.workshopId) {
        const link = await bpxModsCall({ action: "link", workshopId: c.workshopId, source: "manual", resources: c.items });
        if (!link || !link.ok) return { ok: false, error: bpxFailText(link) };
        justLinked.add(String(c.workshopId));
      } else {
        let linked = 0;
        try {
          const { data, error } = await sb.rpc("bp_link_modio", { p_modio_id: Number(c.modioId), p_name: c.modName || "mod.io mod", p_url: bpxModioUrl(c.modioUrl), p_resources: c.items });
          linked = error ? 0 : Number(data) || 0;
        } catch (e) { linked = 0; }
        if (!linked) return { ok: false, error: "Couldn't save the mod link just now. Please try again in a moment." };
        justLinked.add("modio:" + c.modioId);
      }
    }
    return { ok: true, linked: pending.length };
  }

  // ---- fallback for blueprints that do not name their mods: type the Workshop id ----
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
    const unres = uncovered();
    out.innerHTML = modCard(r.mod, "Is this the mod?") +
      `<p><strong>Does this mod provide the content listed above?</strong></p>
       <ul class="depchecks">${unres.map((x, i) => `<li><input type="checkbox" id="depChk${i}" checked><label for="depChk${i}" style="margin:0;font-weight:500">${esc(LABEL[x.type] || x.type)}: <code>${esc(x.path)}</code></label></li>`).join("")}</ul>
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

  function init() {
    $("depModFind").addEventListener("click", manualFind);
    $("depModId").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); manualFind(); } });
    render();
  }

  // mods for the live preview card: known ones plus the ones about to be attached
  function mods() {
    const seen = new Map();
    state.report.filter((x) => x.status === "mod" && x.mod).forEach((x) => {
      const key = x.mod.platform === "modio" ? "modio:" + x.mod.modio_id : String(x.mod.workshop_id);
      seen.set(key, { platform: x.mod.platform, workshop_id: x.mod.workshop_id, modio_id: x.mod.modio_id, name: x.mod.name, url: x.mod.url });
    });
    claimsForUnresolved().filter(claimUsable).forEach((c) => {
      if (c.workshopId) seen.set(c.workshopId, { platform: "steam", workshop_id: c.workshopId, name: c.mod.title });
      else seen.set(c.key, { platform: "modio", modio_id: c.modioId, name: c.modName || "mod.io mod", url: bpxModioUrl(c.modioUrl) });
    });
    return [...seen.values()];
  }

  return {
    init, check, reset, parseRequires, parseRequiredMods, applyClaims, mods,
    isReady, isChecking: () => state.checking,
    set onChange(fn) { onChange = fn; },
    unresolvedPaths: () => uncovered().map((x) => x.path),
  };
})();
