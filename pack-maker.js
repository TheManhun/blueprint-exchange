// BPX Pack Maker -- turns blueprint files from a player's myblueprints folder into a ready Transport Fever 3 mod
// (a "blueprint pack") that PYT - Blueprint Exchange reads from <modId>::/bpxpack/ (TF3 repo DECISIONS T138 / T139).
// Everything happens in the browser: the files are read, checked, converted and zipped here, and nothing is sent anywhere.
//
// A pack mod, as BPX 1.1 reads it:
//   <folder>/mod.json                       modId = <folder>_1
//   <folder>/_content.json                  TF3 loads a mod.io install by this list -- every content file must be in it
//   <folder>/_metadata/modinfo.json         name, authors, summary, description for mod.io
//   <folder>/_metadata/0.png                the mod.io picture (1920 x 1080)
//   <folder>/content/bpxpack/index.lua      return { format = 1, name, author, list = { { file, name, description } } }
//   <folder>/content/bpxpack/<file>.lua     one blueprint each: return { ... }
//
// A saved blueprint is written by the game as `function data() return { ... } end`; a pack file must be `return { ... }`
// (it is loaded as a module), so the wrapper comes off. And since BPX loads these files as Lua, only plain data gets
// through: tables, strings, numbers, true / false / nil -- no calls, no functions, no names that aren't table keys.
(function (root) {
  "use strict";

  const BPX_URL = "https://mod.io/g/transportfever3/m/pyt-blueprint-exchange";
  const MAX_FILE = 2 * 1024 * 1024;
  const MAX_FILES = 100;

  // ---- names --------------------------------------------------------------------------------------------------
  function slug(s, max) {
    return String(s || "").normalize("NFKD").replace(/[̀-ͯ'’]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max || 40).replace(/_+$/, "");
  }
  // a short stable hash, so a name with no Latin letters still gets the same folder every time
  function hash(s) {
    let h = 2166136261 >>> 0;
    for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36).slice(0, 6);
  }
  function folderFor(packName, author) {
    const a = slug(author, 20) || hash(author), n = slug(packName, 32) || hash(packName);
    return "bpxpack_" + a + "_" + n;
  }
  // a blueprint's file key: a plain name only (BPX refuses anything else -- it becomes a file name in bpxdata)
  function fileKey(fileName) {
    return String(fileName || "").replace(/\.lua$/i, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^[_-]+|[_-]+$/g, "").slice(0, 60) || "blueprint";
  }
  // 4_stop_cargo_train_station -> "4 Stop Cargo Train Station" (as BPX names a dropped-in file, T122)
  function niceName(key) {
    const s = String(key).replace(/[_-]+/g, " ").trim().replace(/(^|\s)([a-z])/g, (m, a, b) => a + b.toUpperCase());
    return (s || "Blueprint").slice(0, 40);
  }

  // ---- the blueprint file -------------------------------------------------------------------------------------
  // Walks the Lua text and refuses anything that isn't plain data. Returns null when it's fine, or a reason.
  function plainDataProblem(src) {
    const ALLOWED_WORDS = { "true": 1, "false": 1, "nil": 1 };
    let i = 0, first = true;
    const n = src.length;
    const nextSignificant = (j) => { while (j < n && /\s/.test(src[j])) j++; return j; };
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "-" && src[i + 1] === "-") { // comment
        const lb = /^--\[(=*)\[/.exec(src.slice(i, i + 20));
        if (lb) {
          const close = "]" + lb[1] + "]", end = src.indexOf(close, i + lb[0].length);
          if (end < 0) return "a comment that never ends";
          i = end + close.length;
        } else {
          const end = src.indexOf("\n", i);
          i = end < 0 ? n : end + 1;
        }
        continue;
      }
      if (c === '"' || c === "'") { // quoted string
        let j = i + 1;
        while (j < n && src[j] !== c) { if (src[j] === "\\") j++; if (src[j] === "\n") return "a broken piece of text"; j++; }
        if (j >= n) return "a piece of text that never ends";
        i = j + 1; first = false; continue;
      }
      const lb = c === "[" ? /^\[(=*)\[/.exec(src.slice(i, i + 20)) : null;
      if (lb) { // long string
        const close = "]" + lb[1] + "]", end = src.indexOf(close, i + lb[0].length);
        if (end < 0) return "a piece of text that never ends";
        i = end + close.length; first = false; continue;
      }
      const num = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
      if (num) { i += num[0].length; first = false; continue; }
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 200));
      if (word) {
        const w = word[0], after = nextSignificant(i + w.length);
        if (first) {
          if (w !== "return") return "it doesn't start with 'return'";
        } else if (!ALLOWED_WORDS[w] && !(src[after] === "=" && src[after + 1] !== "=")) {
          return "it contains '" + w + "', which isn't plain blueprint data";
        }
        i += w.length; first = false; continue;
      }
      if ("{}[]=,;-".indexOf(c) >= 0) {
        if (c === "=" && src[i + 1] === "=") return "it contains '==', which isn't plain blueprint data";
        i++; first = false; continue;
      }
      return "it contains '" + c + "', which isn't plain blueprint data";
    }
    if (first) return "it is empty";
    return null;
  }

  // A file from myblueprints (or a built-in style file) -> { ok, body } or { ok: false, why }
  function convertBlueprint(text) {
    let s = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
    if (!s) return { ok: false, why: "The file is empty." };
    const wrapped = /^function\s+data\s*\(\s*\)\s*([\s\S]*)\bend$/.exec(s);
    if (wrapped) s = wrapped[1].trim();
    // a header comment (the built-ins carry one) may sit before 'return'
    const body = s.replace(/^(?:--[^\n]*\n\s*)+/, "");
    if (!/^return\s*\{/.test(body)) return { ok: false, why: "This doesn't look like a BPX blueprint file." };
    const problem = plainDataProblem(body);
    if (problem) return { ok: false, why: "BPX can't use this file: " + problem + "." };
    if (!/\b(?:edges|constructions)\s*=/.test(body)) return { ok: false, why: "This file has no track, roads or stations in it." };
    return { ok: true, body: body };
  }

  // ---- Lua text ---------------------------------------------------------------------------------------------
  function luaString(s) {
    return '"' + String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
  }
  function indexLua(pack, items) {
    const lines = [
      "-- BPX blueprint pack, made with the BPX Pack Maker (tfbpx.com). Read by PYT - Blueprint Exchange.",
      "return {",
      "\tformat = 1,",
      "\tname = " + luaString(pack.name) + ",",
      "\tauthor = " + luaString(pack.author) + ",",
      "\tlist = {",
    ];
    for (const it of items) {
      lines.push("\t\t{ file = " + luaString(it.key) + ", name = " + luaString(it.name) +
        (it.description ? ", description = " + luaString(it.description) : "") + " },");
    }
    lines.push("\t},", "}", "");
    return lines.join("\n");
  }

  // ---- the mods a blueprint uses ------------------------------------------------------------------------------
  // TF3 names everything a mod adds '<modId>::/path' (the game's own: '::/path'), in construction files, station
  // modules, track and road types, decorations -- so a blueprint says itself which mods it needs.
  const BPX_ID = "epod_blueprint_exchange_tf3_1";
  const DLC = { urbangames_deluxe_upgrade_pack: "the Deluxe Upgrade DLC", urbangames_preorder_pack: "the Pre-Order Pack DLC" };
  function modsUsed(body) {
    const found = new Set();
    const re = /["'\[]([A-Za-z0-9_.-]+)::\//g;
    let m;
    while ((m = re.exec(String(body)))) if (m[1] !== BPX_ID) found.add(m[1]);
    return Array.from(found).sort();
  }
  function isDlc(id) { return DLC[id] !== undefined || /^urbangames_/.test(id); }
  // a first guess at a mod's name from its id: epod_pay_your_tolls_tf3_1 -> "Epod Pay Your Tolls Tf3" (the player fixes it)
  function guessModName(id) {
    if (DLC[id]) return DLC[id];
    const s = String(id).replace(/_\d+$/, "").replace(/[_.-]+/g, " ").trim();
    return s.replace(/(^|\s)([a-z])/g, (x, a, b) => a + b.toUpperCase()) || id;
  }
  function andList(words) {
    return words.length <= 1 ? (words[0] || "") : words.slice(0, -1).join(", ") + " and " + words[words.length - 1];
  }

  // ---- the mod's files ----------------------------------------------------------------------------------------
  // pack = { name, author, summary, description, needs, mods: [{ id, name, url }] }, items = [{ key, name, description,
  // body }], picture = Uint8Array (PNG)
  function packFiles(pack, items, picture) {
    const folder = folderFor(pack.name, pack.author);
    const content = [];
    const files = [];
    const add = (path, data) => files.push({ path: folder + "/" + path, data: data });
    // BPX as the pack's dependency: TF3's mod window lists it with its own Activate button (format SEEN 2026-10-07 --
    // Mod.ModDependency in the game's API files: mod = ModRef { modId, revisionMin, revisionMax }, optional, loadBefore, modInfo)
    // and every mod the blueprints use (not DLC -- how TF3 treats a mod depending on DLC is unknown; DLC is named in the
    // description instead)
    const dep = (id, name, url) => ({ mod: { modId: id, revisionMin: 1, revisionMax: 1000 }, optional: false, loadBefore: false,
      modInfo: { displayName: name, url: url || "" } });
    const mods = (pack.mods || []).filter((m) => m && m.id && m.id !== BPX_ID);
    add("mod.json", JSON.stringify({
      dependencies: [dep(BPX_ID, "PYT - Blueprint Exchange", BPX_URL)]
        .concat(mods.filter((m) => !isDlc(m.id)).map((m) => dep(m.id, String(m.name || guessModName(m.id)), m.url))),
      incompatibilities: null, modId: folder + "_1", options: null, params: null,
      postRunScript: { fileName: "" }, preRunScript: { fileName: "" }, revision: 1, runScript: { fileName: "" },
      severityAdd: "None", severityRemove: "None",
    }, null, 4) + "\n");
    for (const it of items) {
      add("content/bpxpack/" + it.key + ".lua",
        "-- " + it.name.replace(/[\r\n]/g, " ") + " -- from the BPX blueprint pack '" + pack.name.replace(/[\r\n]/g, " ") + "'\n" + it.body + "\n");
      content.push("bpxpack/" + it.key + ".lua");
    }
    add("content/bpxpack/index.lua", indexLua(pack, items));
    content.push("bpxpack/index.lua");
    add("_content.json", JSON.stringify({ archives: null, files: content }, null, 4) + "\n");
    const n = items.length;
    const summary = (pack.summary || (n + " blueprint" + (n === 1 ? "" : "s") + " for PYT - Blueprint Exchange.")).slice(0, 250);
    // what else it needs goes FIRST: a player who subscribes without it sees nothing happen (and rates it)
    const extra = String(pack.needs || "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
    const named = mods.map((m) => String(m.name || guessModName(m.id)).trim()).filter(Boolean);
    if (extra) named.push(extra);
    const needs = andList(named);
    const desc = [
      "Needs " + andList(["PYT - Blueprint Exchange"].concat(named)) + ".",
      "",
      pack.description ? pack.description.trim() : summary,
      "",
      "A blueprint pack for PYT - Blueprint Exchange: subscribe, start your game with BPX" + (named.length ? ", " + named.join(", ") : "") +
        " and this pack switched on, then open the BPX Library and pick Show: Packs.",
      "",
      "Blueprints in this pack: " + items.map((it) => it.name).join(", ") + ".",
      "",
      "PYT - Blueprint Exchange: " + BPX_URL,
      "",
      "Made with the BPX Pack Maker on tfbpx.com.",
    ].join("\n");
    add("_metadata/modinfo.json", JSON.stringify({
      authors: [{ name: pack.author, role: "CREATOR" }], name: pack.name, summary: summary, description: desc, tags: [], url: "",
    }, null, 4) + "\n");
    if (picture) add("_metadata/0.png", picture);
    return { folder: folder, modId: folder + "_1", files: files };
  }

  // ---- a plain zip (stored, no compression -- mod.io packs it on upload anyway) -----------------------------------
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zip(files, when) {
    const enc = new TextEncoder();
    const d = when || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.path);
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true); cd.setUint16(12, time, true); cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  // ---- reading a blueprint (plain-data Lua, already checked) into JS ------------------------------------------
  // tables become arrays when their keys are 1..n, objects otherwise. Throws on anything unexpected.
  function parseLuaData(src) {
    let i = 0;
    const n = src.length;
    const fail = (what) => { throw new Error("blueprint data: " + what + " at " + i); };
    function skip() {
      for (;;) {
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] === "-" && src[i + 1] === "-") {
          const lb = /^--\[(=*)\[/.exec(src.slice(i, i + 20));
          if (lb) { const close = "]" + lb[1] + "]", e = src.indexOf(close, i); i = e < 0 ? n : e + close.length; }
          else { const e = src.indexOf("\n", i); i = e < 0 ? n : e + 1; }
          continue;
        }
        return;
      }
    }
    function str() {
      const q = src[i++];
      let out = "";
      while (i < n && src[i] !== q) {
        let c = src[i++];
        if (c === "\\") {
          c = src[i++];
          const map = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", "\\": "\\", '"': '"', "'": "'", "\n": "\n" };
          if (map[c] !== undefined) out += map[c];
          else if (/\d/.test(c)) { const m = /^\d{1,3}/.exec(src.slice(i - 1, i + 2)); out += String.fromCharCode(+m[0]); i += m[0].length - 1; }
          else if (c === "x") { out += String.fromCharCode(parseInt(src.substr(i, 2), 16)); i += 2; }
          else out += c;
        } else out += c;
      }
      i++;
      return out;
    }
    function value() {
      skip();
      const c = src[i];
      if (c === "{") return table();
      if (c === '"' || c === "'") return str();
      if (c === "[") {
        const lb = /^\[(=*)\[/.exec(src.slice(i, i + 20));
        if (!lb) fail("'['");
        const close = "]" + lb[1] + "]", e = src.indexOf(close, i + lb[0].length);
        const s = src.slice(i + lb[0].length, e).replace(/^\n/, "");
        i = e + close.length;
        return s;
      }
      const num = /^-?\s*(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
      if (num) { i += num[0].length; return Number(num[0].replace(/\s+/g, "")); }
      const w = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 20));
      if (w && (w[0] === "true" || w[0] === "false" || w[0] === "nil")) { i += w[0].length; return w[0] === "true" ? true : w[0] === "false" ? false : null; }
      fail("unexpected '" + c + "'");
    }
    function table() {
      i++; // {
      const arr = [], obj = {};
      let pos = 1, keyed = false;
      for (;;) {
        skip();
        if (src[i] === "}") { i++; break; }
        let key = null;
        if (src[i] === "[" && !/^\[=*\[/.test(src.slice(i, i + 20))) {
          i++; key = value(); skip(); if (src[i] !== "]") fail("']'"); i++; skip(); if (src[i] !== "=") fail("'='"); i++;
        } else {
          const w = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 200));
          if (w) { let j = i + w[0].length; while (/\s/.test(src[j])) j++; if (src[j] === "=" && src[j + 1] !== "=") { key = w[0]; i = j + 1; } }
        }
        const v = value();
        if (key === null) { arr[pos - 1] = v; pos++; }
        else if (typeof key === "number" && key === pos) { arr[pos - 1] = v; pos++; }
        else { obj[key] = v; keyed = true; }
        skip();
        if (src[i] === "," || src[i] === ";") i++;
      }
      if (!keyed) return arr;
      arr.forEach((v, k) => { obj[k + 1] = v; });
      return obj;
    }
    skip();
    if (!/^return\b/.test(src.slice(i))) fail("no 'return'");
    i += 6;
    return value();
  }

  // ---- drawing a blueprint, blueprint-paper style ---------------------------------------------------------------
  // nodes = {x, y, z, ...}; edges = { n0, n1, t0, t1, track, bridge?, tunnel? } (Hermite curves, the tangents as the
  // game stores them); constructions = { transf (4x4, x / y at 13 / 14), fileName }. A station's own platforms belong to
  // the station, so it is drawn as a box over the gap its track ends leave.
  function geometry(bp) {
    const nodes = Array.isArray(bp && bp.nodes) ? bp.nodes : [];
    const edges = Array.isArray(bp && bp.edges) ? bp.edges : [];
    const P = (k) => { const nd = nodes[k - 1]; return nd ? { x: +nd[0] || 0, y: +nd[1] || 0 } : null; };
    const lines = [], deg = {};
    for (const e of edges) {
      const p0 = P(e.n0), p1 = P(e.n1);
      if (!p0 || !p1) continue;
      deg[e.n0] = (deg[e.n0] || 0) + 1; deg[e.n1] = (deg[e.n1] || 0) + 1;
      const t0 = e.t0 || [0, 0], t1 = e.t1 || [0, 0];
      const pts = [];
      for (let k = 0; k <= 16; k++) {
        const u = k / 16, h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
        pts.push([h00 * p0.x + h10 * (+t0[0] || 0) + h01 * p1.x + h11 * (+t1[0] || 0), h00 * p0.y + h10 * (+t0[1] || 0) + h01 * p1.y + h11 * (+t1[1] || 0)]);
      }
      lines.push({ pts, track: e.track === true, bridge: !!e.bridge, tunnel: !!e.tunnel });
    }
    const ends = [];
    for (const k in deg) if (deg[k] === 1) { const p = P(+k); if (p) ends.push(p); }
    const boxes = [];
    for (const c of (Array.isArray(bp && bp.constructions) ? bp.constructions : [])) {
      const m = c && c.transf;
      if (!Array.isArray(m) || m.length < 16) continue;
      const cx = +m[12], cy = +m[13];
      // the axis its tracks run along: of its own two axes, the one the open track ends line up on (SEEN: TF3's
      // modular stations run along their y axis, the origin beside the platforms, at the building)
      let best = null;
      for (const raw of [[+m[4], +m[5]], [+m[0], +m[1]]]) {
        const al = Math.hypot(raw[0], raw[1]) || 1, ax = raw[0] / al, ay = raw[1] / al;
        const near = ends.map((p) => { const dx = p.x - cx, dy = p.y - cy; return { along: dx * ax + dy * ay, across: -dx * ay + dy * ax }; })
          .filter((q) => Math.abs(q.across) <= 40 && Math.abs(q.along) <= 800);
        if (!best || near.length > best.near.length) best = { ax, ay, near };
      }
      const { ax, ay, near } = best;
      // along: the gap between the nearest track end on each side (its own platforms fill it); a terminus: one side only
      const plus = near.filter((q) => q.along > 5).map((q) => q.along), minus = near.filter((q) => q.along < -5).map((q) => q.along);
      let lo = minus.length ? Math.max(...minus) : 0, hi = plus.length ? Math.min(...plus) : 0;
      if (hi - lo < 20) { lo = -40; hi = 40; }
      // across: from the origin (the building) out past the furthest platform track
      const inGap = near.filter((q) => q.along >= lo - 1 && q.along <= hi + 1).map((q) => q.across);
      const sLo = Math.min(0, ...inGap) - 6, sHi = Math.max(0, ...inGap) + 6;
      const station = /station|terminal|depot|harbou?r|airport/i.test(String(c.fileName || ""));
      boxes.push({ cx, cy, ax, ay, lo, hi, sLo: Math.min(sLo, -8), sHi: Math.max(sHi, 8), station });
    }
    return { lines, boxes };
  }
  // the layout turned so its long side runs across (its main direction, from the spread of its points): long, thin
  // railway layouts then fill a wide frame instead of a sliver in a square one
  function laidFlat(bp) {
    const g = geometry(bp);
    const corners = (b) => [[b.lo, b.sLo], [b.hi, b.sLo], [b.hi, b.sHi], [b.lo, b.sHi]].map(([a, s]) => [b.cx + a * b.ax - s * b.ay, b.cy + a * b.ay + s * b.ax]);
    const all = [];
    for (const l of g.lines) for (const p of l.pts) all.push(p);
    for (const b of g.boxes) for (const p of corners(b)) all.push(p);
    if (!all.length) return null;
    let mx = 0, my = 0;
    for (const p of all) { mx += p[0]; my += p[1]; }
    mx /= all.length; my /= all.length;
    // the main direction of the track itself (each little stretch votes with its length, direction taken both ways):
    // long straights win, so a crossover's diagonal or a station's position doesn't tilt the drawing
    // the most common direction wins (2-degree bins by length), refined from the track within 1 degree of it -- an
    // average would let a crossover's diagonal pull the whole drawing askew
    const runs = [];
    for (const l of g.lines) {
      for (let k = 1; k < l.pts.length; k++) {
        const dx = l.pts[k][0] - l.pts[k - 1][0], dy = l.pts[k][1] - l.pts[k - 1][1], len = Math.hypot(dx, dy);
        if (len > 0) runs.push({ a: ((Math.atan2(dy, dx) % Math.PI) + Math.PI) % Math.PI, len });
      }
    }
    for (const b of g.boxes) runs.push({ a: ((Math.atan2(b.ay, b.ax) % Math.PI) + Math.PI) % Math.PI, len: b.hi - b.lo });
    const bins = new Array(90).fill(0);
    for (const r of runs) bins[Math.floor(r.a / Math.PI * 90) % 90] += r.len;
    const top = (bins.indexOf(Math.max(...bins)) + 0.5) * Math.PI / 90;
    let vx = 0, vy = 0;
    for (const r of runs) {
      let d = Math.abs(r.a - top); d = Math.min(d, Math.PI - d);
      if (d <= 1 * Math.PI / 180) { vx += r.len * Math.cos(2 * r.a); vy += r.len * Math.sin(2 * r.a); }
    }
    const ang = runs.length ? 0.5 * Math.atan2(vy, vx) : 0, c = Math.cos(-ang), s = Math.sin(-ang);
    const R = (p) => [(p[0] - mx) * c - (p[1] - my) * s, (p[0] - mx) * s + (p[1] - my) * c];
    const lines = g.lines.map((l) => Object.assign({}, l, { pts: l.pts.map(R) }));
    const boxes = g.boxes.map((b) => ({ station: b.station, pts: corners(b).map(R) }));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of all.map(R)) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    return { lines, boxes, x0, y0, x1, y1, aspect: (x1 - x0) / Math.max(y1 - y0, 1) };
  }
  // draw it into the rectangle (x, y, w, h) of a 2d context; returns false when there is nothing to draw
  function drawBlueprint(ctx, bp, x, y, w, h, opt) {
    const o = Object.assign({ ink: "#ffffff", road: "#9fd3ff", fill: "rgba(255,255,255,.10)", scale: 1 }, opt || {});
    const g = laidFlat(bp);
    if (!g) return false;
    const { x0, y0, x1, y1 } = g;
    const pad = 0.08, span = Math.max(x1 - x0, y1 - y0, 1);
    const s = Math.min(w * (1 - 2 * pad) / Math.max(x1 - x0, span * 0.05), h * (1 - 2 * pad) / Math.max(y1 - y0, span * 0.05));
    const ox = x + w / 2 - (x0 + x1) / 2 * s, oy = y + h / 2 + (y0 + y1) / 2 * s; // the game's y runs up, the canvas's down
    const X = (px) => ox + px * s, Y = (py) => oy - py * s;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const b of g.boxes) {
      const c = b.pts;
      ctx.beginPath(); c.forEach((p, k) => (k ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))); ctx.closePath();
      ctx.fillStyle = o.fill; ctx.fill();
      ctx.strokeStyle = o.ink; ctx.lineWidth = 2.5 * o.scale; ctx.setLineDash([]); ctx.stroke();
      if (b.station) { // hatching, as a drawing marks a building
        ctx.save(); ctx.clip();
        ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1.2 * o.scale;
        const xs = c.map((p) => X(p[0])), ys = c.map((p) => Y(p[1]));
        const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
        const r = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        for (let d = -r; d <= r; d += 12 * o.scale) { ctx.beginPath(); ctx.moveTo(mx + d - r, my - r); ctx.lineTo(mx + d + r, my + r); ctx.stroke(); }
        ctx.restore();
      }
    }
    for (const pass of ["road", "track"]) {
      for (const l of g.lines) {
        if ((pass === "track") !== l.track) continue;
        ctx.beginPath(); l.pts.forEach((p, k) => (k ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
        ctx.setLineDash(l.tunnel ? [8 * o.scale, 7 * o.scale] : []);
        if (l.bridge) { ctx.strokeStyle = o.ink; ctx.lineWidth = (l.track ? 7 : 9) * o.scale; ctx.stroke(); ctx.strokeStyle = "#0e2f58"; ctx.lineWidth = (l.track ? 4 : 6) * o.scale; ctx.stroke(); }
        ctx.strokeStyle = l.track ? o.ink : o.road;
        ctx.lineWidth = (l.track ? 2.2 : 4) * o.scale;
        ctx.stroke();
      }
    }
    ctx.restore();
    return true;
  }

  const api = { slug, hash, folderFor, fileKey, niceName, plainDataProblem, convertBlueprint, luaString, indexLua, packFiles, zip, crc32,
    parseLuaData, geometry, laidFlat, drawBlueprint, modsUsed, isDlc, guessModName, andList, BPX_ID, MAX_FILE, MAX_FILES, BPX_URL };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PackMaker = api;
})(typeof window !== "undefined" ? window : this);
