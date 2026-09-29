// Blueprint Exchange -- the ONLY code on tfbpx.com that touches files on your PC.
//
// It runs in your browser, never on a server. It uses the browser's own folder permission (Chrome / Edge:
// "Let site view and edit files?"), so it can only see the folder YOU pick, and only while you allow it.
// What it does with that folder:
//   * lists the names of the files in it, and reads the first lines of blueprint_*.lua files (name, date, version);
//   * writes, copies and deletes blueprint_*.lua files -- only when you press a button that names them first;
//   * writes downloads into the mod's own inbox names (blueprint_import.lua ... blueprint_import_10.lua),
//     only into a slot that is empty, so it never overwrites a download you haven't imported yet;
//   * makes a "BPX backups" folder beside your blueprints for backups and for anything you delete;
//   * if you tick "Sign me in", keeps a random key in bpx_player_key.txt (see playerKey below).
// It never opens any other file, never sends a file anywhere, and never touches the mod's own index or settings.
// Mod folders (optional, a separate tick): only the FOLDER NAMES are read (they are the mod numbers), and the list
// stays in this browser.
//
// Read it all: https://github.com/TheManhun/blueprint-exchange/blob/main/bpx-folder.js

const BPXFolder = (() => {
  const DB_NAME = "bpxManager";
  const STORE = "handles";
  const KEY_FILE = "bpx_player_key.txt";
  const BACKUP_DIR = "BPX backups";
  const CONSENT_KEY = "bpxConsent";
  const MODS_KEY = "bpxMyMods";
  const INBOX_SLOTS = Array.from({ length: 10 }, (_, i) => (i === 0 ? "blueprint_import.lua" : `blueprint_import_${i + 1}.lua`));

  const supported = typeof window !== "undefined" && "showDirectoryPicker" in window;

  // ---- the folder handle, remembered in this browser (IndexedDB can keep it; localStorage can't) ----
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbDo(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  const remember = (name, handle) => idbDo("readwrite", (s) => s.put(handle, name));
  const recall = (name) => idbDo("readonly", (s) => s.get(name)).catch(() => undefined);
  const forgetHandle = (name) => idbDo("readwrite", (s) => s.delete(name)).catch(() => undefined);

  // ---- what the player ticked (kept in this browser only) ----
  function consent() {
    try { return JSON.parse(localStorage.getItem(CONSENT_KEY) || "null") || {}; } catch (err) { return {}; }
  }
  function setConsent(c) {
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ ...c, at: new Date().toISOString() })); } catch (err) { /* fine */ }
  }

  // The remembered blueprint folder, if the browser still allows it. With ask = true (only from a click) the browser
  // may show its "allow again?" prompt; without, a folder that needs asking comes back as "needs-click".
  async function folder(ask) {
    if (!supported || !consent().folder) return { state: "off" };
    const handle = await recall("folder");
    if (!handle) return { state: "none" };
    const opts = { mode: "readwrite" };
    let perm = await handle.queryPermission(opts);
    if (perm === "prompt" && ask) perm = await handle.requestPermission(opts);
    if (perm === "granted") return { state: "ok", dir: handle };
    return { state: perm === "prompt" ? "needs-click" : "denied", dir: handle };
  }

  async function pickFolder() {
    const dir = await window.showDirectoryPicker({ id: "bpx-blueprints", mode: "readwrite" });
    // does it look like the right place? (TransportFever2.exe, the mod's index, or blueprints)
    let looks = false;
    for await (const [name] of dir.entries()) {
      if (/^(TransportFever2\.exe|blueprint_exchange_index\.lua)$/i.test(name) || /^blueprint_.+\.lua$/i.test(name)) { looks = true; break; }
    }
    await remember("folder", dir);
    return { dir, looks };
  }
  const disconnect = () => forgetHandle("folder");

  // ---- small file helpers ----
  async function fileOrNull(dir, name) {
    try { return await (await dir.getFileHandle(name)).getFile(); }
    catch (err) { if (err && err.name === "NotFoundError") return null; throw err; }
  }
  async function writeText(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  async function copyFile(fromDir, toDir, name) {
    const f = await fileOrNull(fromDir, name);
    if (!f) return false;
    await writeText(toDir, name, await f.text());
    return true;
  }

  // Blueprint files only: the mod's own files (blueprint_exchange_*: index, settings, log, undo) and the inbox slots
  // are never listed, so they can't be backed up over or deleted from here.
  const isBlueprintFile = (name) => /^blueprint_.+\.lua$/i.test(name)
    && !/^blueprint_exchange_/i.test(name) && !/^blueprint_import(_\d+)?\.lua$/i.test(name);

  function readHeader(text) {
    const get = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
    const origin = get(/^-- Origin: *([a-z]+)/m);
    return {
      name: get(/^-- Name: *(.+)$/m),
      created: get(/^-- Created: *(.+)$/m),
      constructions: Number(get(/^-- Constructions: *(\d+)/m)) || 0,
      origin: origin || "personal",
      bpxId: (get(/\| Id: *([0-9a-f]+)/m)) || null,
      version: Number(get(/\| Version: *(\d+)/m)) || 1,
    };
  }

  async function listBlueprints(dir) {
    const out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== "file" || !isBlueprintFile(name)) continue;
      const f = await h.getFile();
      const head = readHeader(await f.slice(0, 1200).text());
      out.push({ file: name, size: f.size, modified: f.lastModified, ...head, name: head.name || name.replace(/^blueprint_|\.lua$/g, "").replace(/_/g, " ") });
    }
    return out;
  }

  // ---- the inbox: a slot is free when there is no file, or the mod has emptied it after an import ----
  async function inboxState(dir) {
    const state = [];
    for (const name of INBOX_SLOTS) {
      const f = await fileOrNull(dir, name);
      const waiting = !!f && /\breturn\s*\{/.test(await f.slice(0, 4000).text());
      state.push({ name, waiting });
    }
    return state;
  }
  // Writes a download into the first free slot. Returns the slot name, or null when all 10 are waiting for Import.
  async function sendToGame(dir, text) {
    const free = (await inboxState(dir)).find((s) => !s.waiting);
    if (!free) return null;
    await writeText(dir, free.name, text);
    return free.name;
  }

  // ---- backups: "BPX backups/<date time> <label>/" beside the blueprints ----
  const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, "-");
  async function backup(dir, names, label) {
    const root = await dir.getDirectoryHandle(BACKUP_DIR, { create: true });
    const folderName = `${stamp()} ${label}`.trim();
    const into = await root.getDirectoryHandle(folderName, { create: true });
    let n = 0;
    for (const name of names) if (isBlueprintFile(name) && await copyFile(dir, into, name)) n++;
    return { folder: `${BACKUP_DIR}/${folderName}`, count: n };
  }
  // Delete = back up first, then remove. Nothing is deleted if the backup failed.
  async function remove(dir, names) {
    const safe = names.filter(isBlueprintFile);
    const saved = await backup(dir, safe, "deleted");
    if (saved.count !== safe.length) throw new Error(`Backed up ${saved.count} of ${safe.length} -- nothing was deleted.`);
    for (const name of safe) await dir.removeEntry(name);
    return saved;
  }
  async function listBackups(dir) {
    let root;
    try { root = await dir.getDirectoryHandle(BACKUP_DIR); } catch (err) { return []; }
    const out = [];
    for await (const [name, h] of root.entries()) {
      if (h.kind !== "directory") continue;
      const files = [];
      for await (const [fname, fh] of h.entries()) if (fh.kind === "file" && isBlueprintFile(fname)) files.push(fname);
      out.push({ name, files: files.sort() });
    }
    return out.sort((a, b) => b.name.localeCompare(a.name));
  }
  // Puts files from a backup back. Never overwrites a blueprint that is there now (it is listed as skipped).
  async function restore(dir, backupName, names) {
    const from = await (await dir.getDirectoryHandle(BACKUP_DIR)).getDirectoryHandle(backupName);
    const done = [], skipped = [];
    for (const name of names) {
      if (!isBlueprintFile(name)) continue;
      if (await fileOrNull(dir, name)) { skipped.push(name); continue; }
      if (await copyFile(from, dir, name)) done.push(name);
    }
    return { done, skipped };
  }

  // ---- sign-in key: 64 random hex characters in bpx_player_key.txt. The server only ever keeps its SHA-256. ----
  async function playerKey(dir, create) {
    const f = await fileOrNull(dir, KEY_FILE);
    if (f) {
      const m = (await f.text()).match(/\b([0-9a-f]{64})\b/);
      if (m) return m[1];
    }
    if (!create) return null;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    await writeText(dir, KEY_FILE,
      "Blueprint Exchange sign-in key for tfbpx.com. Keep it private: whoever has it can see your download history.\r\n"
      + "Delete this file (and press Forget me on the Blueprint Manager page) to stop being signed in.\r\n"
      + key + "\r\n");
    return key;
  }
  async function dropKey(dir) {
    try { await dir.removeEntry(KEY_FILE); } catch (err) { /* already gone */ }
  }

  // ---- mods you have: folder names only (Steam: ...\steamapps\workshop\content\1066780; mod.io: ...\mod.io\6791\mods) ----
  async function readModFolder(kind) {
    const dir = await window.showDirectoryPicker({ id: `bpx-mods-${kind}`, mode: "read" });
    const ids = [];
    for await (const [name, h] of dir.entries()) if (h.kind === "directory" && /^\d{3,20}$/.test(name)) ids.push(name);
    return { folder: dir.name, ids };
  }
  function myMods() {
    try { return JSON.parse(localStorage.getItem(MODS_KEY) || "null"); } catch (err) { return null; }
  }
  function setMyMods(kind, ids) {
    const cur = myMods() || { workshop: [], modio: [] };
    cur[kind] = ids;
    cur.at = new Date().toISOString();
    try { localStorage.setItem(MODS_KEY, JSON.stringify(cur)); } catch (err) { /* fine */ }
    return cur;
  }
  function clearMyMods() { try { localStorage.removeItem(MODS_KEY); } catch (err) { /* fine */ } }

  return { supported, consent, setConsent, folder, pickFolder, disconnect, listBlueprints, inboxState, sendToGame,
           backup, remove, listBackups, restore, playerKey, dropKey, readModFolder, myMods, setMyMods, clearMyMods,
           isBlueprintFile, INBOX_SLOTS, KEY_FILE, BACKUP_DIR };
})();
