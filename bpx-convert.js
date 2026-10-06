// BPX blueprint converter: Transport Fever 2 blueprints -> Transport Fever 3, in the browser (Epod: "a live translator,
// so whether they download for TF3 or TF2 they get the right file"). Rules, not AI: the same file always converts the
// same way, and what has no TF3 counterpart is named in the notes instead of guessed at silently.
//
// The rules are the ones that turned 60 of TF2 BPX's built-ins into TF3's (tools/convert_tf2_builtins.py in the TF3 mod's
// repo, T124), widened to everything the tfbpx.com library uses (read 2026-10-07: 95 TF2 blueprints). With
// { builtin: true } the output matches that tool exactly (the parity test).
//
// TF2 file (blueprint = 1, game = "tf2"): nodes { relative {x,y,z}, construction?, anchor { piece } }, edges { n0, n1, t0,
// t1, track, trackTypeName | streetTypeName, catenary, edgeType 1 bridge / 2 tunnel, edgeTypeName, objects { model,
// param, oneWay, left } }, constructions { fileName, params { modules { [slot] = { name, variant } }, length, seed,
// tracks, year }, relative, yaw, name }.
// TF3 file (what BPX TF3 saves): nodes { x, y, z, above[, piece] }, edges { n0, n1, t0, t1, track, roadTemplate,
// bridge? tunnel? signals { con, param, oneWay, dir, waypoint } }, constructions { fileName, params { length, seed,
// tracks, year, specialization, upgrade, bpxModuleList { {slot, {name, variant}} } }, transf, above, name, modules,
// paramsFrom }, adapt = true (BPX fits it to the save's year when pasted).
(function (root) {
  "use strict";

  // ---- reading Lua data (plain data only: tables, strings, numbers, booleans) ---------------------------------
  function parseLua(src) {
    let i = 0;
    const n = src.length;
    const fail = (what) => { throw new Error("not a readable blueprint (" + what + " at character " + i + ")"); };
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
      if (i >= n) fail("unfinished text");
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
        if (e < 0) fail("unfinished text");
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
      i++;
      const arr = [], obj = {};
      let pos = 1, keyed = false;
      for (;;) {
        skip();
        if (i >= n) fail("unfinished table");
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
        else if (typeof key === "number" && key === pos && !keyed) { arr[pos - 1] = v; pos++; }
        else { obj[key] = v; keyed = true; }
        skip();
        if (src[i] === "," || src[i] === ";") i++;
      }
      if (!keyed) return arr;
      arr.forEach((v, k) => { obj[k + 1] = v; });
      return obj;
    }
    let s = String(src).replace(/^﻿/, "").replace(/^(?:\s*--[^\n]*\n)+/, ""); // leading comment lines (ours carry one)
    const wrapped = /^\s*function\s+data\s*\(\s*\)\s*([\s\S]*)\bend\s*$/.exec(s);
    if (wrapped) { s = wrapped[1]; }
    src = s;
    i = 0;
    skip();
    if (!/^return\b/.test(src.slice(i))) fail("no 'return'");
    i += 6;
    const v = value();
    return v;
  }

  // ---- writing Lua (as the TF3 tool does: keys sorted, numbers to 4 places) ---------------------------------------
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  function num(v) {
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  function luaValue(v, ind) {
    ind = ind || 0;
    const pad = "\t".repeat(ind + 1);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return num(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (v.every((x) => x === null || typeof x !== "object")) return "{ " + v.map((x) => luaValue(x)).join(", ") + " }";
      return "{\n" + v.map((x) => pad + luaValue(x, ind + 1) + ",\n").join("") + "\t".repeat(ind) + "}";
    }
    if (v && typeof v === "object") {
      return "{\n" + Object.keys(v).sort().map((k) => pad + (IDENT.test(k) ? k : "[" + JSON.stringify(k) + "]") + " = " + luaValue(v[k], ind + 1) + ",\n").join("") +
        "\t".repeat(ind) + "}";
    }
    if (v === null || v === undefined) return "nil";
    throw new Error("can't write " + typeof v);
  }

  // ---- the name tables (TF3 names from TF3's own files) ----------------------------------------------------------
  const r4 = (x) => Math.round(Number(x) * 1e4) / 1e4;
  const TRACK = { "standard.lua": "standard", "high_speed.lua": "high_speed" };
  function trackTemplate(tf2, catenary) {
    const k = TRACK[tf2];
    if (!k) return null;
    return "::/infrastructure/track/" + k + "/" + k + (catenary ? "_catenary" : "") + ".street_template";
  }
  // standard/town_large_old.lua -> ::/infrastructure/street/town/town_old_large.street_template
  function streetTemplate(tf2, note) {
    const m = /^standard\/(town|country)_(x_large|small|medium|large)(_one_way)?_(old|new)\.lua$/.exec(String(tf2));
    if (!m) return null;
    let [, kind, size, oneWay, era] = m;
    if (oneWay) {
      if (kind === "town") {
        if (size === "large" || size === "x_large") { note("approx", "TF3 has no large one-way town road: the medium one is used"); size = "medium"; }
        return "::/infrastructure/street/town/town_new_one_way_" + size + ".street_template";
      }
      // TF3 has no one-way country road: its highways are the one-way roads between towns
      note("approx", "TF3 has no one-way country road: its highway of the same size is used");
      return "::/infrastructure/street/highway/highway_new_" + (size === "x_large" ? "large" : size) + ".street_template";
    }
    if (size === "x_large") { note("approx", "TF3 has no extra-large " + kind + " road: the large one is used"); size = "large"; }
    return "::/infrastructure/street/" + kind + "/" + kind + "_" + era + "_" + size + ".street_template";
  }
  const BRIDGE = { "stone.lua": "::/infrastructure/bridge/stone.bridge", "iron.lua": "::/infrastructure/bridge/steel.bridge",
    "cement.lua": "::/infrastructure/bridge/concrete.bridge" };
  const TUNNEL_ROAD = { "street_old.lua": "::/infrastructure/tunnel/tunnel_a_car.tunnel", "street_new.lua": "::/infrastructure/tunnel/tunnel_b_car.tunnel" };
  const TUNNEL_RAIL = { "railroad_old.lua": "::/infrastructure/tunnel/tunnel_a.tunnel", "railroad_new.lua": "::/infrastructure/tunnel/tunnel_b.tunnel" };
  const SIGNAL = { "railroad/signal_path_a.mdl": "::/infrastructure/signal/signal_path_a.con",
    "railroad/signal_path_a_one_way.mdl": "::/infrastructure/signal/signal_path_a.con",
    "railroad/signal_path_c.mdl": "::/infrastructure/signal/signal_path_c.con",
    "railroad/signal_path_c_one_way.mdl": "::/infrastructure/signal/signal_path_c.con" };
  // a station's platform track: TF3 names it after the track itself ("::/trainstation_" .. resName with :: -> __)
  const PLATFORM_TRACK = { "platform_track.module": ["standard", false], "platform_track_catenary.module": ["standard", true],
    "platform_high_speed_track.module": ["high_speed", false], "platform_high_speed_track_catenary.module": ["high_speed", true] };
  function moduleName(tf2, builtin) {
    const file = String(tf2).split("/").pop();
    if (builtin) { // the TF3 tool's rule exactly
      if (tf2 === "station/rail/modular_station/platform_track.module") return "::/trainstation___/infrastructure/track/standard/standard.street_template";
      if (String(tf2).indexOf("station/rail/modular_station/") === 0) return "::/stations/rail/modular_station/" + file;
      return null;
    }
    if (PLATFORM_TRACK[file] && String(tf2).indexOf("station/rail/modular_station/") === 0) {
      const [k, cat] = PLATFORM_TRACK[file];
      return "::/trainstation___/infrastructure/track/" + k + "/" + k + (cat ? "_catenary" : "") + ".street_template";
    }
    if (String(tf2).indexOf("station/rail/modular_station/") === 0) return "::/stations/rail/modular_station/" + file;
    return null;
  }
  // TF2 and TF3 share GetId (3400000 + offset + 3000 i + 40 j + 10 k + o); only the building-size digit o differs
  const O_MAP = { 0: 0, 1: 1, 5: 5, 6: 0, 7: 1 };
  function slotTf3(slot) {
    if (slot >= 3000000 && slot < 4000000) {
      const o = slot % 10;
      if (O_MAP[o] === undefined) return null;
      return slot - o + O_MAP[o];
    }
    return slot;
  }
  // The size digit of a building slot must be the TF3 BUILDING's size: TF3 reads it to find the building's place (SEEN
  // 2026-10-07: a community station's two side_building_3 sat in TF2's size-2 slots; TF3's side_building_3 is size 3 --
  // 'No main building data for slotId ... with offset 1', then a fatal 'Duplicate edges found' on paste). Sizes from
  // TF3's own module files (rail_building_sizeN): the number in the name is not always the size (side_building_3_cargo
  // is size 2).
  const SIZE_DIGIT = { 1: 5, 2: 0, 3: 1 };
  function buildingSize(tf3Name) {
    const m = /\/(main|side)_building_(\d)_([a-z_]+)\.module$/.exec(String(tf3Name));
    if (!m) return null;
    if (m[1] === "side" && m[2] === "3" && m[3] === "cargo") return 2;
    return { main1: 2, main2: 2, main3: 3, side1: 1, side2: 2, side3: 3 }[m[1] + m[2]] || null;
  }
  // ...but a slot sized up overlaps its neighbours (SEEN, the same station after the fix above: the size-3 buildings'
  // footpaths landed on the next buildings' -- 'Duplicate edges found' again). So keep TF2's SIZE (its slot digit: main
  // 0 / 1 = size 2 / 3, side 5 / 6 / 7 = size 1 / 2 / 3) -- the layout keeps its spacing -- and pick the TF3 building of
  // that size in the same family (main / side, era / cargo): TF2's side_building_3 era a is size 2 there, TF3's is 3.
  const TF2_SIZE = { 0: 2, 1: 3, 5: 1, 6: 2, 7: 3 };
  function fitBuilding(tf2Slot, tf3Name) {
    const m = /^(.*\/)(main|side)_building_(\d)_([a-z_]+)\.module$/.exec(String(tf3Name));
    if (!m || tf2Slot < 3000000 || tf2Slot >= 4000000) return null;
    const o2 = ((tf2Slot % 10) + 10) % 10;
    const want = TF2_SIZE[o2];
    if (!want) return null;
    const [, dir, kind, , fam] = m;
    let name = tf3Name;
    if (buildingSize(name) !== want) {
      const cargo = fam === "cargo";
      const pick = kind === "main" ? { 2: "main_building_2", 3: "main_building_3" }[want]
        : cargo ? { 1: "side_building_1", 2: "side_building_2", 3: "main_building_3" }[want]   // no size-3 cargo side building
          : { 1: "side_building_1", 2: "side_building_2", 3: "side_building_3" }[want];
      if (!pick) return null;
      name = dir + pick + "_" + fam + ".module";
    }
    return { name, slot: tf2Slot - o2 + SIZE_DIGIT[want] };
  }
  const modOf = (fileName) => { const m = /^([A-Za-z0-9_.-]+)\//.exec(String(fileName)); return m ? m[1] : ""; };

  // ---- one blueprint -------------------------------------------------------------------------------------------
  // returns { ok, bp, notes: [{ kind: "approx" | "dropped" | "info", text }], name } -- ok false (with notes) when nothing
  // usable is left. opt.builtin: the TF3 tool's exact behaviour (refuse instead of dropping / approximating).
  function tf2ToTf3(tf2, opt) {
    opt = opt || {};
    const notes = [];
    const seen = {};
    const note = (kind, text) => { if (!seen[text]) { seen[text] = true; notes.push({ kind, text }); } };
    const refuse = (why) => { const e = new Error(why); e.refused = true; throw e; };
    if (!tf2 || typeof tf2 !== "object") refuse("not a blueprint");
    if (tf2.game && tf2.game !== "tf2") refuse("this blueprint is already for " + String(tf2.game).toUpperCase());

    // constructions: rail stations convert; the rest is named and left out
    const consOut = [], dropCon = {}, newIndex = {}; // newIndex: a kept construction's number in TF2 -> in the output
    (tf2.constructions || []).forEach((c, ci) => {
      const fn = String(c.fileName || "");
      const skip = (why) => { if (opt.builtin) refuse(why); dropCon[ci + 1] = true; note("dropped", why); };
      if (fn.indexOf("industry/") === 0) return skip("industries are left out (BPX never copies industries)");
      if (fn === "station/street/modular_terminal.con") return skip("road terminals are left out for now (TF3 builds them differently)");
      if (fn !== "station/rail/modular_station/modular_station.con") return skip("'" + fn + "' is left out (no TF3 counterpart" + (modOf(fn) ? ", or it is another mod's" : "") + ")");
      const p = c.params || {};
      const mods = [];
      const modules = p.modules || {};
      const slots = Object.keys(modules).map(Number).sort((a, b) => a - b);
      for (const slot of slots) {
        const m = modules[slot] || {};
        const name = moduleName(m.name, opt.builtin);
        const s3 = slotTf3(slot);
        if (!name || s3 === null) {
          if (opt.builtin) refuse(!name ? "module " + m.name : "building slot " + slot);
          note("dropped", "a station part TF3 doesn't have was left out (" + String(m.name).split("/").pop() + ")");
          continue;
        }
        const fit = fitBuilding(slot, name);
        if (fit && fit.name !== name && opt.builtin) refuse("building size " + name);
        if (fit && fit.name !== name) note("approx", "a station building TF3 makes bigger was swapped for TF3's one of the same size, so the layout keeps its spacing");
        mods.push([fit ? fit.slot : s3, { name: fit ? fit.name : name, variant: Math.trunc(Number(m.variant) || 0) }]);
      }
      const params = { length: Math.trunc(Number(p.length) || 0) + 1, // TF3's lmap starts one earlier (lmap[length + 1])
        seed: Math.trunc(Number(p.seed) || 0), tracks: Math.trunc(Number(p.tracks) || 0), year: Math.trunc(Number(p.year === undefined ? 1900 : p.year)),
        specialization: 1, upgrade: false, bpxModuleList: mods };
      const yaw = Number(c.yaw) || 0;
      const rel = (c.relative || [0, 0, 0]).concat([0, 0, 0]);
      const ca = Math.cos(yaw), sa = Math.sin(yaw);
      consOut.push({ fileName: "::/stations/rail/modular_station/modular_station.con", params,
        transf: [r4(ca), r4(sa), 0, 0, r4(-sa), r4(ca), 0, 0, 0, 0, 1, 0, r4(rel[0]), r4(rel[1]), r4(rel[2]), 1],
        above: 0, name: c.name || "BPX Station", modules: mods.length, paramsFrom: "native" });
      newIndex[ci + 1] = consOut.length;
    });

    // nodes -- a node anchored to a construction (anchor.piece = its number in the blueprint) keeps that link,
    // renumbered for the constructions kept; anchored to one left out, it is an ordinary node (SEEN 2026-10-07: dropping
    // EVERY anchor when Regional Hub's two road terminals were left out cut its track off its rail station too --
    // 'Construction Not Possible' wherever it was pasted)
    const nodesIn = tf2.nodes || [];
    const nodesOut = nodesIn.map((nd) => {
      const rel = (nd.relative || [0, 0, 0]).concat([0, 0, 0]);
      const rec = [r4(rel[0]), r4(rel[1]), r4(rel[2]), r4(rel[2])]; // flat ground: height above it = its own height
      if (nd.construction) {
        const old = Math.trunc(Number((nd.anchor || {}).piece) || 1);
        if (opt.builtin) rec.push(old);
        else if (newIndex[old]) rec.push(newIndex[old]);
      }
      return rec;
    });

    // edges
    const edgesOut = [];
    for (const e of tf2.edges || []) {
      const rec = { n0: e.n0, n1: e.n1, t0: (e.t0 || []).map(r4), t1: (e.t1 || []).map(r4), track: !!e.track };
      const tmpl = e.track ? trackTemplate(e.trackTypeName, e.catenary) : streetTemplate(e.streetTypeName, opt.builtin ? () => refuse("street " + e.streetTypeName) : note);
      if (!tmpl) {
        if (opt.builtin) refuse((e.track ? "track " + e.trackTypeName : "street " + e.streetTypeName));
        note("dropped", "pieces of '" + (e.track ? e.trackTypeName : e.streetTypeName) + "' are left out (another mod's, or no TF3 counterpart)");
        continue;
      }
      rec.roadTemplate = tmpl;
      const et = Number(e.edgeType) || 0;
      if (et === 1) {
        const b = BRIDGE[e.edgeTypeName];
        if (!b) { if (opt.builtin) refuse("bridge " + e.edgeTypeName); note("approx", "a bridge type TF3 doesn't have became a stone bridge"); }
        rec.bridge = b || BRIDGE["stone.lua"];
      } else if (et === 2) {
        if (e.track && opt.builtin) refuse("rail tunnel");
        const t = (e.track ? TUNNEL_RAIL : TUNNEL_ROAD)[e.edgeTypeName];
        if (!t) { if (opt.builtin) refuse("tunnel " + e.edgeTypeName); note("approx", "a tunnel type TF3 doesn't have became TF3's first tunnel"); }
        rec.tunnel = t || (e.track ? TUNNEL_RAIL["railroad_old.lua"] : TUNNEL_ROAD["street_old.lua"]);
      }
      const sigs = [];
      for (const o of e.objects || []) {
        const con = SIGNAL[o.model];
        if (!con) { if (opt.builtin) refuse("signal " + o.model); note("dropped", "a signal TF3 doesn't have was left out"); continue; }
        sigs.push({ con, param: r4(o.param), oneWay: !!o.oneWay, dir: !o.left, waypoint: false }); // TF3 keeps the opposite of left (T78b)
      }
      if (sigs.length) rec.signals = sigs;
      edgesOut.push(rec);
    }
    if (!opt.builtin) {
      if (Array.isArray(tf2.decorations) && tf2.decorations.length) note("dropped", "decorations and trees are left out (TF3's models have other names)");
    }
    if (!edgesOut.length && !consOut.length) {
      const e = new Error("nothing in it converts to TF3"); e.refused = true; e.notes = notes; throw e;
    }
    const name = String(tf2.name || opt.key || "Blueprint").replace(/^BPX\s+/, "");
    const description = String(tf2.description || "").replace("Needs 1925 or later (one-way streets)", "Needs 1940 or later (one-way streets)");
    const out = { name, description, origin: opt.builtin ? "builtin" : "tf2", adapt: true, radius: 0,
      captured: opt.builtin ? "built-in" : "converted from TF2", nodes: nodesOut, edges: edgesOut, constructions: consOut };
    if (!opt.builtin) note("info", "Fitted to your year when you paste it: track, roads, signals and station buildings.");
    return { ok: true, bp: out, notes, name };
  }

  // a TF2 file's text -> { ok, text (a TF3 myblueprints file), name, notes } or { ok: false, why, notes }
  function convertText(text, opt) {
    let tf2;
    try { tf2 = parseLua(text); } catch (e) { return { ok: false, why: e.message, notes: [] }; }
    try {
      const r = tf2ToTf3(tf2, opt);
      const body = luaValue(r.bp);
      return { ok: true, name: r.name, notes: r.notes, bp: r.bp,
        text: "-- " + r.name.replace(/[\r\n]/g, " ") + " -- converted from Transport Fever 2 by tfbpx.com\nfunction data()\nreturn " + body + "\nend\n" };
    } catch (e) {
      return { ok: false, why: e.message, notes: e.notes || [] };
    }
  }

  const api = { parseLua, luaValue, tf2ToTf3, convertText, streetTemplate, trackTemplate, moduleName, slotTf3 };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.BpxConvert = api;
})(typeof window !== "undefined" ? window : this);
