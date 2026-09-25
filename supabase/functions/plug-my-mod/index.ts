// Plug My Mod -- Blueprint Exchange's community promotion of Transport
// Fever 2 Steam Workshop items.
//
// The browser sends only a Workshop item NUMBER (plus, on submit, a short
// plain-text description and the permission tick). Everything else -- the
// title, author, preview image and the Steam link -- comes from Steam
// itself, fetched here, so a submitter cannot make the page show anything
// Steam doesn't say. The canonical link is built here (and the database
// re-checks it), arbitrary URLs and images are never accepted, and the
// preview image is fetched once, checked, and cached in Storage so the
// page never hotlinks Steam per visit.
//
//   POST { action: "lookup", workshopId: "3800813265" }
//   POST { action: "submit", workshopId, description?, consent: true }
//
// Public by design (anyone may plug a mod), so there is no login to check;
// the protections are: origin allow-list, strict validation, per-caller
// rate limits (a salted hash of the address, never the address), a daily
// cap on new listings, and duplicate blocking.

import { createClient } from "jsr:@supabase/supabase-js@2";

const TF2_APP_ID = 1066780;

const ALLOWED_ORIGINS = new Set([
  "https://tfbpx.com",
  "https://www.tfbpx.com",
  "https://themanhun.github.io",
  "http://127.0.0.1:8765", // local testing of the page
  "http://localhost:8765",
]);

const STEAM_API = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const MAX_BODY_BYTES = 4096;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_DESCRIPTION = 200;

const LOOKUPS_PER_HOUR = 20;
const SUBMITS_PER_DAY = 5;
const NEW_LISTINGS_PER_DAY = 200; // everyone together

const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ---------- small helpers ----------

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Plain text only: no control characters, no angle brackets, collapsed spaces
// (\s also catches the Unicode line separators).
function cleanText(input: unknown, max: number): string {
  let s = typeof input === "string" ? input : "";
  s = s.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, max).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function callerAddress(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function steamUrlFor(id: string): string {
  return "https://steamcommunity.com/sharedfiles/filedetails/?id=" + id;
}

function imageHostAllowed(host: string): boolean {
  return (
    host === "steamuserimages-a.akamaihd.net" ||
    host === "steamcdn-a.akamaihd.net" ||
    host === "steamusercontent.com" || host.endsWith(".steamusercontent.com") ||
    host === "steamstatic.com" || host.endsWith(".steamstatic.com")
  );
}

// ---------- database client + rate limiting ----------

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

let cachedSalt: string | null = null;
async function ipSalt(): Promise<string> {
  if (cachedSalt) return cachedSalt;
  const { data, error } = await db.from("pm_secrets").select("value").eq("name", "ip_salt").single();
  if (error || !data) throw new Error("rate-limit salt unavailable");
  cachedSalt = data.value as string;
  return cachedSalt;
}

async function enforceLimit(ipHash: string, kind: "lookup" | "submit", limit: number, windowMs: number, message: string) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const { count, error } = await db.from("pm_rate_events").select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash).eq("kind", kind).gte("at", since);
  if (error) throw new Error("rate-limit check failed: " + error.message);
  if ((count ?? 0) >= limit) throw new HttpError(429, "rate_limited", message);
  const ins = await db.from("pm_rate_events").insert({ ip_hash: ipHash, kind });
  if (ins.error) throw new Error("rate-limit record failed: " + ins.error.message);
}

// ---------- Steam ----------

type SteamItem = {
  workshopId: string;
  title: string;
  creatorId: string | null;
  authorName: string | null;
  previewUrl: string | null;
};

async function steamLookup(workshopId: string): Promise<SteamItem> {
  let res: Response;
  try {
    res = await fetchWithTimeout(STEAM_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ itemcount: "1", "publishedfileids[0]": workshopId }).toString(),
    }, 8000);
  } catch (_e) {
    throw new HttpError(502, "steam_unavailable", "Steam didn't answer just now. Please try again in a minute.");
  }
  if (!res.ok) throw new HttpError(502, "steam_unavailable", "Steam didn't answer just now. Please try again in a minute.");

  let d: any;
  try {
    d = (await res.json())?.response?.publishedfiledetails?.[0];
  } catch (_e) {
    throw new HttpError(502, "steam_unavailable", "Steam sent back something unexpected. Please try again in a minute.");
  }

  if (!d || Number(d.result) !== 1) {
    throw new HttpError(404, "not_found", "We couldn't find a Steam Workshop item with that number. Check the number and try again.");
  }
  if (Number(d.consumer_app_id) !== TF2_APP_ID) {
    throw new HttpError(422, "not_tf2", "That Workshop item isn't for Transport Fever 2.");
  }
  if (d.banned && Number(d.banned) !== 0) {
    throw new HttpError(422, "not_available", "Steam has removed that Workshop item, so it can't be listed.");
  }
  if (d.visibility !== undefined && Number(d.visibility) !== 0) {
    throw new HttpError(422, "not_public", "That Workshop item isn't public yet. Make it public on Steam, then try again.");
  }
  if (d.file_type !== undefined && d.file_type !== null && Number(d.file_type) !== 0) {
    throw new HttpError(422, "not_a_mod", "That Workshop entry isn't a mod. It may be a collection or a screenshot.");
  }

  const title = cleanText(d.title, 120);
  if (!title) throw new HttpError(422, "no_title", "That Workshop item has no title, so it can't be listed.");

  const creatorId = typeof d.creator === "string" && /^[0-9]{5,20}$/.test(d.creator) ? d.creator : null;

  // Best effort: the creator's public Steam name. Never fatal.
  let authorName: string | null = null;
  if (creatorId) {
    try {
      const r = await fetchWithTimeout("https://steamcommunity.com/profiles/" + creatorId + "/?xml=1", {}, 4000);
      if (r.ok) {
        const m = (await r.text()).match(/<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/);
        if (m) authorName = cleanText(m[1], 80) || null;
      }
    } catch (_e) { /* leave it blank */ }
  }

  // Steam's own image address, only if it is on one of Steam's image hosts.
  let previewUrl: string | null = null;
  try {
    if (typeof d.preview_url === "string") {
      const u = new URL(d.preview_url);
      if (u.protocol === "https:" && imageHostAllowed(u.hostname)) previewUrl = u.toString();
    }
  } catch (_e) { /* no usable image */ }

  return { workshopId, title, creatorId, authorName, previewUrl };
}

function sniffMatches(type: string, b: Uint8Array): boolean {
  if (type === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/png") return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (type === "image/gif") return b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
  if (type === "image/webp") return b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  return false;
}

// Fetch Steam's preview once. Only Steam image hosts, only https, redirects
// re-checked at every hop, size-capped, and the bytes must really be the
// image type the server claims. Returns null (never throws) if anything is off.
async function fetchPreviewImage(url: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  try {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(current);
      if (u.protocol !== "https:" || !imageHostAllowed(u.hostname)) return null;
      const res = await fetchWithTimeout(current, { redirect: "manual" }, 8000);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok || !res.body) return null;
      const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_EXT[type]) return null;
      if (Number(res.headers.get("content-length") || "0") > MAX_IMAGE_BYTES) return null;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_IMAGE_BYTES) { await reader.cancel(); return null; }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.length; }
      return sniffMatches(type, bytes) ? { bytes, type } : null;
    }
  } catch (_e) { /* fall through */ }
  return null;
}

// ---------- the two actions ----------

function publicMod(item: SteamItem, extra: Record<string, unknown> = {}) {
  return {
    workshopId: item.workshopId,
    title: item.title,
    author: item.authorName,
    steamUrl: steamUrlFor(item.workshopId),
    previewUrl: item.previewUrl,
    ...extra,
  };
}

async function existing(workshopId: string) {
  const { data } = await db.from("pm_mods").select("workshop_id, title, image_path, status").eq("workshop_id", workshopId).maybeSingle();
  return data;
}

async function handle(req: Request, origin: string | null): Promise<Response> {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "That request was too large.");
  let body: any;
  try { body = JSON.parse(raw); } catch (_e) { throw new HttpError(400, "bad_request", "That request wasn't understood."); }
  if (!body || typeof body !== "object") throw new HttpError(400, "bad_request", "That request wasn't understood.");

  const action = body.action;
  if (action !== "lookup" && action !== "submit") throw new HttpError(400, "bad_request", "That request wasn't understood.");

  const workshopId = typeof body.workshopId === "string" ? body.workshopId.trim() : "";
  if (!/^[0-9]{6,12}$/.test(workshopId)) {
    throw new HttpError(400, "bad_id", "Enter just the Workshop item number: digits only, no link. It's the number at the end of the item's Steam address.");
  }

  const ipHash = await sha256Hex((await ipSalt()) + ":" + callerAddress(req));
  await enforceLimit(ipHash, "lookup", LOOKUPS_PER_HOUR, 3600_000, "You've looked up a lot of mods in a short time. Please try again in a little while.");

  if (Math.random() < 0.05) {
    await db.from("pm_rate_events").delete().lt("at", new Date(Date.now() - 2 * 86400_000).toISOString());
  }

  if (action === "lookup") {
    const item = await steamLookup(workshopId);
    const already = await existing(workshopId);
    return json(200, { ok: true, mod: publicMod(item, { alreadyListed: !!already }) }, origin);
  }

  // ---- submit ----
  if (body.consent !== true) {
    throw new HttpError(400, "consent_required", "Please tick the box to confirm you have permission to promote this Workshop item.");
  }
  const description = cleanText(body.description, MAX_DESCRIPTION);

  if (await existing(workshopId)) {
    throw new HttpError(409, "already_listed", "That Workshop item is already on the list.");
  }

  await enforceLimit(ipHash, "submit", SUBMITS_PER_DAY, 86400_000, "You've submitted several mods today. Please try again tomorrow.");
  const since = new Date(Date.now() - 86400_000).toISOString();
  const { count: recent } = await db.from("pm_mods").select("id", { count: "exact", head: true }).gte("created_at", since);
  if ((recent ?? 0) >= NEW_LISTINGS_PER_DAY) {
    throw new HttpError(429, "busy", "A lot of mods have been added today. Please try again tomorrow.");
  }

  const item = await steamLookup(workshopId);

  // cache the preview image into our own storage, once
  let imagePath: string | null = null;
  if (item.previewUrl) {
    const img = await fetchPreviewImage(item.previewUrl);
    if (img) {
      const path = "mods/" + workshopId + "." + IMAGE_EXT[img.type];
      const up = await db.storage.from("plug-my-mod").upload(path, img.bytes, { contentType: img.type, upsert: true, cacheControl: "86400" });
      if (!up.error) imagePath = path;
      else console.error("image upload failed:", up.error.message);
    }
  }

  const { error } = await db.from("pm_mods").insert({
    workshop_id: workshopId,
    title: item.title,
    author_name: item.authorName,
    author_steamid: item.creatorId,
    steam_url: steamUrlFor(workshopId),
    original_preview_url: item.previewUrl,
    image_path: imagePath,
    description: description || null,
    consent: true,
    status: "approved",
  });
  if (error) {
    if ((error as any).code === "23505") throw new HttpError(409, "already_listed", "That Workshop item is already on the list.");
    throw new Error("insert failed: " + error.message);
  }

  return json(200, { ok: true, mod: publicMod(item, { imagePath, description: description || null }) }, origin);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only." }, origin);
  // a browser from some other website is refused outright
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(403, { ok: false, error: "This request isn't allowed from here." }, origin);

  try {
    return await handle(req, origin);
  } catch (e) {
    if (e instanceof HttpError) {
      return json(e.status, { ok: false, code: e.code, error: e.message, ...e.extra }, origin);
    }
    console.error("plug-my-mod failed:", (e as Error)?.message || e);
    return json(500, { ok: false, code: "server_error", error: "Something went wrong on our side. Please try again in a minute." }, origin);
  }
});
