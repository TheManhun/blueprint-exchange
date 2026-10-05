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

  // ---- the mod's files ----------------------------------------------------------------------------------------
  // pack = { name, author, summary, description }, items = [{ key, name, description, body }], picture = Uint8Array (PNG)
  function packFiles(pack, items, picture) {
    const folder = folderFor(pack.name, pack.author);
    const content = [];
    const files = [];
    const add = (path, data) => files.push({ path: folder + "/" + path, data: data });
    add("mod.json", JSON.stringify({
      dependencies: null, incompatibilities: null, modId: folder + "_1", options: null, params: null,
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
    const desc = [
      pack.description ? pack.description.trim() : summary,
      "",
      "A blueprint pack for PYT - Blueprint Exchange: subscribe, start your game with BPX and this pack switched on, then open the BPX Library and pick Show: Packs.",
      "",
      "Blueprints in this pack: " + items.map((it) => it.name).join(", ") + ".",
      "",
      "Needs PYT - Blueprint Exchange: " + BPX_URL,
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

  const api = { slug, hash, folderFor, fileKey, niceName, plainDataProblem, convertBlueprint, luaString, indexLua, packFiles, zip, crc32,
    MAX_FILE, MAX_FILES, BPX_URL };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PackMaker = api;
})(typeof window !== "undefined" ? window : this);
