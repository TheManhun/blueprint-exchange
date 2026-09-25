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
  stored): 60 lookups/hour per caller (rolling hour), 600 lookups/hour
  overall, 5 submissions/day per caller, 200 new listings/day overall.
  A limited reply carries `retryAfter` (seconds, also as a Retry-After
  header) and the page shows the wait; if Steam itself answers 429 the
  function passes on Steam's Retry-After (`code: steam_rate_limited`); duplicates are refused;
- only accepts requests from this site (CORS allow-list: tfbpx.com, www.tfbpx.com, the old github.io address, and local test ports).

Listings are approved automatically. To take one down:

    update public.pm_mods set status = 'hidden' where workshop_id = <id>;

`pm_list()` (security definer, granted to anon) is the only way the
page reads the table. The tables have row-level security on with no
policies, so nothing is reachable directly.

## Ownership and editing (no accounts)

The original captured `blueprint_<name>.lua` is the recovery key. It
carries a private `ownerSecret` (40 hex characters, made by the mod --
see Decision 36 in the mod repo).

- **Upload:** `bp_upload` hashes the key (SHA-256) into
  `bp_blueprint_owners`, strips every ownership field from the public
  copy by name (`ownerSecret`, `ownerKey`, `owner_key`, `editKey`,
  `recoveryToken`, `browserToken`) and then *checks* the result: if any of
  those names, or the key's own value, is still in the text the upload is
  refused rather than published. Only the original uploader's file can
  publish a new version of the same blueprint.
- **Remembering a browser:** after the file proves ownership
  (`bp_claim_browser`), this browser creates a random 256-bit token in
  localStorage (`bpxBrowserToken`; a cookie can't be shared with the
  Supabase domain). The server keeps only the token's hash, per
  blueprint, in `bp_browser_access` (revocable via `revoked_at`). The
  private key itself is never stored in the browser.
- **Library page:** asks `bp_my_blueprints(token)` which blueprints this
  browser may edit and adds an Edit button to just those cards.
- **My blueprints** (Upload page): list with Edit and "Remove this
  browser's access" (`bp_revoke_browser`: forgets the permission only;
  never touches the blueprint or the ownership hash).
- **Edit page** (`edit.html?b=<blueprint id>`): title, description and
  screenshot only, via `bp_edit`, which re-checks the token server-side.
  Not editable: id, owner hash, downloads, version history, author (the
  Official pass-phrase is typed there), the file. New versions go through
  the normal upload (`Upload New Version`).
- **New computer / cleared browser:** "I own this blueprint" on the Upload
  page: choose the original file(s) -- no list to pick from; each file names its own blueprint and the server compares its key. A wrong or public
  file gets one generic message; wrong attempts are rate-limited (20/hour
  per salted address hash, `bp_recovery_attempts`).
- **Uploading a file whose blueprint already exists:** if the key matches,
  the page offers Edit Existing Blueprint / Upload New Version instead of
  silently adding a version; if the id is taken by someone else the upload
  is refused up front.

Not built (would need schema work): categories and tags. Blueprints
uploaded before ownership keys existed have no key on record and can't be
recovered; the one such row in the library is unaffected.

`supabase/migrations/bp_ownership.sql` is the migration that was applied.
The functions were exercised inside a transaction that was rolled back
(wrong/missing/other-blueprint keys, stranger uploads, revocation, rate
limiting), so no test data was left in production.

## Automatic categories

Each blueprint's type is worked out from its own data, not typed in.
`bp_categories(content)` (migration `supabase/migrations/bp_categories.sql`)
is run by `bp_upload` on every upload and stored in `bp_blueprints.categories`;
`bp_list` returns it, and the library page shows a badge per type, a chip
per type with counts, and a filter. The upload page shows the detected type
before you publish, using the same rules in `site.js` (`bpxCategories`).

| Type | Detected from |
| --- | --- |
| Truck station | places `station/street/*` with cargo modules |
| Bus station | places `station/street/*` with passenger modules |
| Rail station | places `station/rail/*` |
| Airport / Harbour / Depot | places `station/air/*`, `station/water/*`, `depot/*` |
| Road network / Rail network | no station-like construction, and the file lists street / track types |
| Bridges & tunnels | the file lists bridge or tunnel types |
| Other | nothing recognised |

A blueprint can have several (a station on a bridge, a road-over-rail
crossing). The SQL and JS rules were checked against each other on 16
sample blueprints. Trains depots built from the modular station are
currently "Rail station" -- the data has no separate marker for them.

## Feature dots on the upload page

Under the file chooser a status line (grey "Waiting for blueprint
inspection", green "Blueprint format is clean", red with the reason if the
file is refused) sits above a grid of grey dots (Cargo train station,
Passenger train station, Cargo truck station, Bus station, Depot, Signals,
Train tracks, Roads, Bridge, Tunnel) that turn green for whatever `bpxFeatures()` in
`site.js` finds in the chosen file. It reads the file's own data only (the
constructions it places and the street/track/bridge/tunnel/model types it
lists), runs entirely in the browser, and changes nothing that is uploaded.

## Mod dependency resolution

A blueprint's `requires` block lists resource PATHS (constructions, track,
street, bridge and tunnel types, signal models) but never which Workshop mod
supplies them. BPX learns that once per mod:

1. **Read all groups.** `bp_requires(content)` (and `deps.js` in the browser)
   read every group of the block, whatever order the mod wrote them in.
2. **Base game or external?** `bp_base_resources` is the game's own list
   (`tools/gen_base_resources.py` builds it from the install; `building/*`
   constructions count as base wholesale). Unknown is not unsafe -- an
   unknown path inside a valid dependency field is fine.
3. **Which mod?** `bp_mod_resources` maps (type, path) to a Workshop item:
   `resource_path`, `resource_type`, `workshop_id`, `mod_name`, canonical
   `steam_url`, `preview_url`, `verified`, `source` (`scan` or `manual`),
   `confirmations`. One mod can map many paths; one (game, type, path,
   workshop id) is stored once, and when two mods claim the same path the
   one with most confirmations wins. `verified` becomes true when two
   different callers (salted address hashes in `bp_mod_confirmers`) confirm
   the same mapping. Base-game paths can never be mapped to a mod.
4. **Teaching it.** The upload page offers *Find Required Mod* (pick your
   `steamapps\workshop\content\1066780` folder; the browser matches
   `<id>/res/<kind>/<path>` against file NAMES only, on your computer) or
   *Enter Steam Workshop ID Manually* (digits only, confirmed with a
   checkbox per resource). Either way the Edge Function `plug-my-mod`
   (`link` action) verifies the item with Steam (exists, public, Transport
   Fever 2) and calls `bp_link_mod`, which only the service role can run.
   Only Workshop ids and resource paths are ever sent.
5. **Publishing.** `bp_upload` reads the requires list from the file itself
   and refuses a blueprint whose external content is still unidentified.
   Editing an existing blueprint's metadata is never blocked by this.
6. **Showing it.** `bp_list` returns `mods` (identified Workshop mods) and
   `unresolved` (paths still unidentified). Cards show "Requires: N
   Workshop mods" and expand to the mod names with Steam links, or
   "Requires external content" plus the raw paths for legacy uploads.

First real case: PYT_Test needs `asset/epod_shared_gantry_1850_noroad.con`;
scanning the Workshop folder found it under item 3800813265 (Pay Your Tolls 2)
and that mapping is now in the database.

Moderation: `delete from public.bp_mod_resources where id = <id>;` removes a
wrong mapping.

### Optional full Workshop scan (community contribution)

Once the current blueprint's dependencies are resolved, the upload page
offers "Help improve BPX mod detection". *Scan My Workshop Mods* reads only
file NAMES under the chosen `steamapps\workshop\content\1066780` folder, in the
browser, and indexes what a layout can capture: constructions (`res/construction/**.con`),
street / track / bridge / tunnel types (`res/config/**.lua`) and signal models.
Trains, vehicles, sounds, UI, scripts and other models are ignored. The result
is a report -- mods scanned, mods with relevant assets, mappings found, already
known (`bp_known_resources`), new -- and **nothing is sent** until the uploader
reviews the exact list and chooses *Submit Blueprint + Help TFBPX*. *Submit
Blueprint Only* publishes the blueprint and shares nothing extra. Sharing goes
through the Edge Function's `bulk_link` action: one Steam call verifies every
Workshop id (public, Transport Fever 2), unknown or base-game paths are
dropped, 3 shares per caller per day, at most 60 mods / 3000 resources per
request. Only Workshop ids, resource types and resource paths are sent; the
mod name comes from Steam. Station/platform *modules* are not indexed: a
blueprint's `requires` block does not list them, so nothing could use them.

## New versions keep the screenshot

A new version is a new library row, so publishing one used to drop the
blueprint's screenshot. When the file's key proves the visitor owns an existing
blueprint that already has a screenshot, the upload page shows it with
"Keep my current screenshot" (ticked). A screenshot added on the page replaces
it; unticking publishes the version without one. Editing an existing blueprint
on `edit.html` already kept the screenshot unless a new one is chosen.

## `requiredMods` in blueprints (capture-time provenance)

New captures can carry `requiredMods = {{ workshopId = "3800813265", resources = {"asset/....con"} }}`:
which Workshop mod supplies which of the layout's files (only mods the layout
actually uses; local, non-Workshop mods are recorded by folder name and can't
be linked). The mod's loader half (`bp_provenance.lua`, run from `mod.lua`) watches
`loadConstruction/Street/Track/Bridge/Tunnel/Model` and notes `getCurrentModId()`
per resource into `blueprint_exchange_mods.lua`; capture reads it back. It is a
CLAIM inside an uploaded file, so the upload page only offers it as "This
blueprint says it needs this mod" (verified with Steam, one click to confirm);
`requires` stays the authoritative check and the scan / manual routes remain the
fallback for blueprints captured before this existed.
