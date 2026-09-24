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
