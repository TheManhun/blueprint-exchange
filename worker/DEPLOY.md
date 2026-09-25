# Deploying the thumbnail Worker

Stage 2 only -- this Worker's one job is: take a WebP blob, write it to
the `blueprint-thumbnails` R2 bucket, hand back the public URL. It
never talks to Supabase.

## 1. Deploy

From this `worker/` folder:

```
npx wrangler login          # opens a browser, sign in to your Cloudflare account
npx wrangler deploy
```

Wrangler reads `wrangler.toml`, which already names the bucket
(`blueprint-thumbnails`) and binds it as `BLUEPRINT_THUMBNAILS`. If
the bucket doesn't exist yet under that exact name, create it first:

```
npx wrangler r2 bucket create blueprint-thumbnails
```

(You said in your brief you'd already created it -- if so, `wrangler
deploy` alone is enough.)

Deploy prints the Worker's URL, something like:

```
https://blueprint-exchange-thumbnails.<your-subdomain>.workers.dev
```

## 2. Wire the frontend to it

Open `index.html`, find this line near the bottom (search for
`WORKER_UPLOAD_URL`):

```js
const WORKER_UPLOAD_URL = "";
```

Paste the deployed URL between the quotes and save. That's the only
edit needed on the frontend side.

## 3. Verify the round trip

1. Open `index.html` in a browser (double-click the file is fine).
2. Under "Preview image (optional)", press **Add a preview image**,
   paste or choose any screenshot, position it, press **Use image**.
3. A **Test R2 upload** button appears under the preview. Press it.
4. It should report "Uploaded. Public URL: ..." with a working link --
   click it and confirm the image actually loads in a new tab.

If it fails instead, the message on the page says why:

- **"origin not allowed"** -- you opened the page from `file://`
  instead of the site. The Worker only accepts the origins listed in
  `ALLOWED_ORIGINS` in `src/index.js` (tfbpx.com, www.tfbpx.com and the old
  github.io address). To test
  locally before the page is redeployed, temporarily add your local
  origin to the Worker's allow-list, deploy, test, then remove it
  again before this goes live.
- **"not a valid WebP file" / "expected Content-Type: image/webp"**
  -- shouldn't happen with the stage 1 cropper's own output; would
  point at something upstream changing the blob.
- **Request failed... check CORS** -- the Worker isn't deployed yet,
  or `WORKER_UPLOAD_URL` is wrong.

## What's NOT done yet (stage 3)

This upload is still a manual, isolated test. The real "Upload to the
library" button does not call the Worker and does not touch
`thumbnail_url` in Supabase -- that's the next stage, once you've
confirmed this round trip works.
