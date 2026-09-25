# Blueprint Exchange Library

Community library for the **Blueprint Exchange** Transport Fever 2 mod: browse, download and share layout blueprints (stations, yards, junctions, whole complexes with their track).

Live page: https://themanhun.github.io/blueprint-exchange/

Blueprint files are stored in Supabase (see `supabase_setup.sql`), not in this repo -- the page assembles each download from the stored data and shows where to put the file.

## Credit

Inspired by [Copy It! by okeating](https://steamcommunity.com/sharedfiles/filedetails/?id=2992565461) -- its approach to capturing and rebuilding constructions and track is the foundation Blueprint Exchange builds on.

## Preview images (optional)

Uploaders can attach a screenshot: pasted or chosen in the browser,
cropped to 16:9 and re-encoded to a small WebP client-side (never the
original file), then uploaded through a Cloudflare Worker (`worker/`
in this repo) straight into an R2 bucket. Only the resulting public
URL is stored in Supabase, as `thumbnail_url` -- no image data and no
R2 credentials ever touch this repo or the Supabase database directly.
Blueprints without a preview work exactly as before; browse cards show
a plain placeholder instead of a broken-image icon.

## Ownership (why one uploader can't overwrite another's blueprint)

Every card is tied to a hidden `blueprintId`, set once by the mod at
capture and permanent from then on -- re-uploading the same design
updates its existing card; a different id makes a new one. Since that
id is plain text in the file, the mod also writes an `ownerSecret`
into the same personal file (never shown in game, never printed in
the file's own header comment). The first upload of an id claims it
by storing a hash of that secret; any later upload of the same id
must match it or is rejected. Downloads never carry the secret --
`bp_upload` strips it from the stored text before anyone else can see
the file.

## Batch downloads

Every download used to be named `blueprint_import.lua`, so grabbing a
second blueprint before importing the first left Windows appending
`(1)` to the filename -- and only the plain name was ever recognised.
The site now cycles consecutive downloads across five known names
(`blueprint_import.lua` through `blueprint_import_5.lua`) and the mod
checks all five in one press of Import a download, so a batch of
downloads (up to five in flight) imports together. Sixth without
importing wraps back to slot 1 and overwrites it.

## Ten inbox slots, blocked and counted

Consecutive downloads in a browser session now cycle through 10 known
names (`blueprint_import.lua` through `blueprint_import_10.lua`,
matching the mod's `bp_files.INBOX_SLOTS`). A small indicator above
the Browse list shows how many are waiting; reaching 10 blocks further
downloads with a clear message and an "I've moved them -- reset
downloads" button, rather than silently wrapping and overwriting an
unimported file. Slot-counting logic was unit-tested with a mock
sessionStorage before commit (sequential 1..10 naming, 11th blocked
without incrementing, reset returns to slot 1).

## Placeholder art

Epod's `card-noimage.webp` shows on every browse card that has no
uploaded preview, instead of the old plain gradient -- a real image,
never a broken-link icon. `drop-placeholder.webp` illustrates the
empty state of the upload dialog's paste/choose-a-file box, before an
image is loaded.

## Placeholder art on the share form itself

`drop-placeholder.webp` now also shows on the Share a blueprint form's
Preview image field by default, before Add a preview image is ever
pressed -- not just inside the popup dialog. It hides once an image is
chosen and reappears if that image is removed.

## Card thumbnail crop bug (found and fixed)

Browse cards were cropping preview images far more aggressively than
the cropper's own 480x270 export -- root cause: `.thumb` set a CSS
`width` but relied on `aspect-ratio: 16/9` to derive the height, while
the `<img>` tag's own `height="270"` HTML attribute counts as an
already-definite height in the box-sizing algorithm, so `aspect-ratio`
never got to compute it from the real rendered width. The box ended
up (card width) x 270px -- nowhere near 16:9 -- and `object-fit: cover`
zoomed hard to fill that mismatched box, chopping the sides off.
Fixed with one rule, `height: auto` on `.thumb`, letting `aspect-ratio`
actually control the box. Verified with a real Chromium instance:
before the fix a card rendered at ratio 1.18 (should be 1.78); after,
1.7779. The exported thumbnail file itself was always a correct,
undistorted 480x270 -- confirmed against two real uploads in
production -- so no crop/export logic needed to change, only the
card's own display CSS.

## One preview-image slot, not two

Rebuilt the Preview image field to a single persistent slot (240x135,
right beside the Add a preview image button) instead of a separate
placeholder banner above a hideable "ready" box -- the two-box layout
could show its ready box (with a dead blob: src) at the same time as
the empty-state button, looking broken. Now there is exactly one
`<img>`, always populated: placeholder art by default, the real crop
once chosen, back to placeholder on Remove. Also caught the same
CSS trap as the download-block banner earlier: `#thumbReadyActions`
had an unconditional `display: flex` that beat the `hidden` attribute,
so Change/Remove image showed even in the empty state -- guarded with
`:not([hidden])`.

## Unique visitors

The stats row shows an all-time unique-visitor count. Each browser
keeps a random id in localStorage (no IP, no real identity) sent once
per page load to `bp_track_visit`; `bp_visit_days` keeps a
one-row-per-visitor-per-day history for a future chart, queryable via
`bp_visit_stats`. No direct table access from the page -- both go
through security-definer functions only.

## Support

A Buy Me a Coffee button (the official CDN-hosted badge, no login
needed to embed it) sits at the bottom of the page, linking to
https://buymeacoffee.com/epodtheman5.

## About page

`about.html` carries the full story (the Workshop/mod.io listing text)
so the library page stays about the library. Linked from the front
page's intro line; links back to the library and the guide.

## Blueprint Importer generator

The "Make Your Own Blueprint Importer" panel builds a small Windows
`.bat` in the browser (no server call) that moves `blueprint_import*.lua`
from the player's Downloads folder into the Transport Fever 2 folder,
where the mod's ten inbox slots live. The Downloads folder box is optional (tucked under "My Downloads folder is somewhere else"): left blank, the script uses `%USERPROFILE%\Downloads`, so most people only confirm the game folder. The script prints the folder it searched, and its "nothing found" message points people with a moved Downloads folder back to that box. Two ways to get it: Copy BAT Code
(shown in a code box with Notepad save-as steps, copied with real CRLF
line endings) or Download My Blueprint Importer.

Safety: the two folder paths are the only user input that reaches the
.bat, and they are validated first -- surrounding quotes stripped, then
anything with a quote, `%`, or a character Windows forbids in folder
names (`< > | ? *`) is refused, and the path must be a real drive-letter
or network path. Inside `set "NAME=value"` a validated path is inert. The
script only ever names `blueprint_import*.lua` (never deletes, never
touches other files); paths with non-ASCII letters get a `chcp 65001`
line so accented Windows user names work.

Tested by driving the real form in a browser, downloading the generated
file, and running it with cmd.exe against sandbox folders: paths with
spaces, `&` and parentheses; accented folder names; nothing-to-move;
game folder missing; unrelated files left alone; the mod's placeholder
slot file overwritten by the real download.

## Banner

`bpx-banner-1060.jpg` / `bpx-banner-2120.jpg` (from the BPX banner art)
are the page heading on the library page, and a link home at the top of
the guide and About pages, served with `srcset` so big screens get the
sharp one and phones the small one. The banner's own fan-made /
not-affiliated line is too small to read on a phone, so the same wording
is real text near the bottom of the library page.

## Visitor counting only counts real visits

`bp_track_visit` is skipped when the page is opened from disk or from a
local test server (localhost / 127.0.0.1), so an author's own local
testing never counts as a visitor. The stat itself is still read and
shown.

Incident, 25 Sep 2026: the visitor tables were wiped on the assumption
that the ~32 rows were automated-test noise. That was wrong -- the
Supabase edge request logs showed 24 genuine browsers from around the
world (Edge, Opera, Firefox, an Android phone) arriving from the live
site, with only about 8 rows being test browsers. The rows were rebuilt
from those logs: one row per distinct browser (grouped by network and
browser, then the network address was discarded -- only random
`restored-...` ids were stored, never an IP or anything derived from
one), with first/last seen, page-load counts and visit-days from the
POST requests. It is an approximation: the logs do not hold the
anonymous id, so a returning visitor is counted once more under their
real id. Lesson: check the request logs before deleting anything
assumed to be test data."

## Site structure (restructure, 25 Sep 2026)

Six pages share one header (banner + nav buttons cut from
`documents/web_buttons.png` in the mod repo: dark = normal, blue =
hover / current page) and one footer (fan-made disclaimer, Copy It!
credit, back link, coffee button):

| Page | File | What lives there |
| --- | --- | --- |
| Community Blueprints | `index.html` | stats, search / Official-Community filter / sort, card grid, download |
| Upload My Blueprint | `upload.html` | step cards, upload form, cropper, live preview card |
| Guides | `guides.html` | download & import, capture, upload, find folder, dependencies, troubleshooting |
| Tools | `tools.html` | Blueprint Importer Builder (.bat generator) |
| Plug My Mod | `plug-my-mod.html` | Workshop item lookup + community mod grid |
| About | `about.html` | the story, credit, public beta, disclaimer |

**`src/` is the source of truth.** Edit `src/*.html`, `src/_header.html`,
`src/_footer.html`, then run `python build.py` to regenerate the root
pages (`python build.py --check` fails if they are stale). Shared
styling is `site.css`; shared script (Supabase client, visitor
tracking, card template) is `site.js`. Old links keep working:
`guide.html` redirects to `guides.html#capture`, and `index.html#share`,
`#importer`, `#use` redirect to the new pages.

Categories / tags / dependency filters were left out on purpose: they
would need a schema change and a new `bp_upload` signature. Filters are
Official / Community only.

## Plug My Mod

Anyone can list a Steam Workshop item for Transport Fever 2. They enter
only the numeric item id; the `plug-my-mod` Edge Function
(`supabase/functions/plug-my-mod/index.ts`) does the rest:

- asks Steam's public `GetPublishedFileDetails` whether the item exists,
  is public, isn't banned, is a Workshop item and belongs to TF2
  (app 1066780); refuses anything else;
- builds the canonical `https://steamcommunity.com/sharedfiles/filedetails/?id=<id>`
  link itself (a DB CHECK constraint enforces the same shape) -- no
  submitted links or images are ever stored or shown;
- downloads Steam's preview image once (image-host allow-list, magic-byte
  check, 3 MB cap, redirects re-validated) and stores it in the public
  Storage bucket `plug-my-mod`; the grid shows that cached copy, so
  Steam is not hit on every page view (the one-off "Is this your mod?"
  confirmation card shows Steam's image directly, once per lookup);
- description is optional plain text, HTML stripped, 200 characters max;
- rate limits by salted hash of the caller's IP (raw IPs are never
  stored): 20 lookups/hour, 5 submissions/day per caller, 200 new
  listings/day overall; duplicates are refused;
- only accepts requests from this site (CORS allow-list: tfbpx.com, www.tfbpx.com, the old github.io address, and local test ports).

Listings are approved automatically. To take one down:

    update public.pm_mods set status = 'hidden' where workshop_id = <id>;

`pm_list()` (security definer, granted to anon) is the only way the
page reads the table. The tables have row-level security on with no
policies, so nothing is reachable directly.
