// Blueprint Exchange -- thumbnail upload Worker.
//
// Sole job: accept a small WebP blob from the Pages frontend and write
// it to the bound R2 bucket, returning its public URL. No Supabase
// call lives here -- the frontend saves thumbnail_url itself once it
// has this Worker's response (stage 3). This file has no secrets in
// it; the R2 bucket is reached only through the binding Wrangler sets
// up, never through an API token the browser could see.

const ALLOWED_ORIGIN = "https://themanhun.github.io";
const ALLOWED_TYPES = new Set(["image/webp"]);
const MAX_BYTES = 200 * 1024; // 200 KB -- the frontend targets ~100 KB; this is headroom, not the target
const PUBLIC_BASE = "https://pub-ea55f87d66c04139a2a7ac3704e9c05e.r2.dev";

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  }
  return headers;
}

function json(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

function uuid() {
  // crypto.randomUUID() is available in the Workers runtime.
  return crypto.randomUUID();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return json(405, { ok: false, error: "POST only" }, origin);
    }

    if (origin !== ALLOWED_ORIGIN) {
      return json(403, { ok: false, error: "origin not allowed" }, origin);
    }

    const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();

    if (!ALLOWED_TYPES.has(contentType)) {
      return json(415, { ok: false, error: "expected Content-Type: image/webp" }, origin);
    }

    const contentLengthHeader = request.headers.get("Content-Length");

    if (contentLengthHeader && Number(contentLengthHeader) > MAX_BYTES) {
      return json(413, { ok: false, error: "image too large (max 200 KB)" }, origin);
    }

    const body = await request.arrayBuffer();

    if (body.byteLength === 0) {
      return json(400, { ok: false, error: "empty body" }, origin);
    }

    if (body.byteLength > MAX_BYTES) {
      return json(413, { ok: false, error: "image too large (max 200 KB)" }, origin);
    }

    // Minimal magic-byte check: a RIFF....WEBP container. Cheap insurance
    // against a mislabelled upload landing in the bucket as .webp.
    const head = new Uint8Array(body.slice(0, 12));
    const isRiff = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46; // "RIFF"
    const isWebp = head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50; // "WEBP"

    if (!isRiff || !isWebp) {
      return json(400, { ok: false, error: "not a valid WebP file" }, origin);
    }

    const key = `blueprints/${uuid()}.webp`;

    try {
      await env.BLUEPRINT_THUMBNAILS.put(key, body, {
        httpMetadata: { contentType: "image/webp" },
      });
    } catch (err) {
      return json(500, { ok: false, error: "R2 write failed" }, origin);
    }

    return json(200, {
      ok: true,
      key,
      url: `${PUBLIC_BASE}/${key}`,
    }, origin);
  },
};
