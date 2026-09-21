# Dragon Oak canonical catalog (ADRIAN catalog v1)

The ADRIAN catalog is the **source of truth** for every product. DragonOakStudio.com and Etsy are both **sales channels**
that receive the same SKU, images and metadata. Etsy is never the product database.

```
catalog/
  collections.json        the 5 customer collections (Halloween, Christmas, Cute Bookmarks, Wine & Hill Country, Other Seasonal)
  products/<SKU>.json     ONE FILE PER PRODUCT  (canonical; private inputs live here)
  examples/               copy-and-edit examples (not built, not published)
  schema/product.schema.json   JSON Schema ADRIAN can validate against
  public/catalog.json     GENERATED public feed (published products only)
  import/                 reports written by the Etsy import (not published)
assets/products/<SKU>/    product images (the same files are used for the site and for Etsy uploads)
shop/  product/  sitemap.xml   GENERATED static pages. Never edit by hand.
```

## How ADRIAN Image Factory adds an approved product

1. Put the approved images in `assets/products/<SKU>/1.webp`, `2.webp`, ... (`.webp`, `.jpg`, `.jpeg` or `.png`).
2. Write `catalog/products/<SKU>.json` (see `catalog/examples/` and `catalog/schema/product.schema.json`). The file name
   must be exactly `<SKU>.json`.
3. Run `npm run catalog:build`. It validates every product, then regenerates the pages. If anything is wrong it stops and
   says what, and writes nothing.
4. Run `npm test`.
5. Push a branch. Vercel makes a preview. A person approves it. Only then is it merged.

Use `"siteState": "draft"` until a person has approved the product. Only `"published"` products appear on the site.

## Rules the build enforces

- One SKU, one id, one slug and one Etsy listing ID per product (no duplicates).
- `collection` is one of the five slugs. **Product type is a separate field**: `digital_download` or `physical_product`.
- Titles and tags follow Etsy's limits (title 140 characters; up to 13 tags of 20 characters), so the same text can go to Etsy.
- A published product needs a description and at least one image file that exists.
- `digitalFiles[].ref` must be an opaque `adrian:...` reference. It can never be a URL or a file path, and it is **never
  published**. Digital files are delivered by the sales channel (Etsy), not by this static site.
- Etsy links are only shown when `etsy.state` is `active` and the address is an `https://...etsy.com` URL. Otherwise the
  product page offers "Ask About This Piece", which goes to the contact form.

## Importing existing Etsy listings (read-only)

The importer only **reads** from Etsy (through the existing protected `/api/etsy-listings` endpoint) and only **proposes
changes to files in this repo**. It cannot create, edit, deactivate or delete an Etsy listing.

```
# 1) Dry run. Writes nothing. Shows what it would do.
#    (set ADRIAN_BRIDGE_SECRET in your terminal first; it is never printed or saved)
npm run etsy:import -- --site https://dragonoakstudio.com

# 2) Write draft products (also downloads each new listing's photos from Etsy's public image CDN)
npm run etsy:import -- --site https://dragonoakstudio.com --write --download-images

# 3) Review the drafts, then
npm run catalog:build
npm test
```

How listings are matched: by **Etsy listing ID** first, then by **SKU**. Never by title.

- Listing already in the catalog: only its `etsy` block (listing ID, URL, state, sync time) is updated. ADRIAN's title,
  description, price, tags, images, collection and site state are **not** overwritten. If Etsy's title or price differs,
  the report lists it as "drift" for ADRIAN to decide.
- Listing not in the catalog: a new **draft** product is created (never published automatically). Its collection is
  guessed from the title and tags and must be confirmed. If Etsy has no usable SKU, a temporary `ETSY-<listing id>` SKU is
  assigned; replace it with the real SKU (rename the file to match).
- Conflicts (a SKU already mapped to a different listing, one listing matching two products, unknown Etsy state) are
  reported and skipped.

`?detail=full`, `state`, `limit` and `offset` are optional read-only parameters on `/api/etsy-listings`. With no
parameters that endpoint behaves exactly as before.

## One-command Etsy sync (dry run) for ADRIAN

```
npm run etsy:sync -- --dry-run          (same thing: node tools/etsy-sync.js --dry-run)
```

This is the command ADRIAN / local automation runs. It **only reads and reports**. It cannot write a file or change Etsy:
there is no write option (`--write`, `--download-images`, `--publish` are refused), and tests fail if a file is written or
any request other than a read (GET) is made. `--dry-run` is required so nobody mistakes it for a real sync.

What it does: it finds the bridge secret in ADRIAN's own private setup, asks the existing protected `/api/etsy-listings`
endpoint for **every** listing state (active, inactive, draft, sold out, expired), runs the existing mapper, and prints one line per
listing (Etsy listing ID, SKU, title, Etsy state, suggested collection, digital/physical, flags) followed by three lists:
listings that cannot be confidently classified, SKU problems (missing, badly formatted, duplicated), and conflicts with the
existing catalog. Add `--json` to get the same report as JSON for ADRIAN to read.

**Where the secret comes from (nobody copies or pastes it into a command).** The secret is set once, in ADRIAN's own private setup.
The command looks in this order:

1. the `ADRIAN_BRIDGE_SECRET` environment variable of the process that runs the command (ADRIAN sets it for the command),
2. a plain-text file whose path is in `ADRIAN_BRIDGE_SECRET_FILE` (works everywhere, but on Windows it has no owner-only protection, so it is not recommended there),
3. **Windows:** the protected file `%LOCALAPPDATA%\ADRIAN\bridge-secret.dpapi`. **macOS/Linux:** the file `.adrian/bridge-secret` in the home folder (`chmod 600`).

Windows does **not** use a plain-text `.adrian\bridge-secret` file. It uses Windows' own protected storage (DPAPI): the secret is
encrypted by Windows for your Windows account, and the command asks Windows PowerShell (built into Windows 10 and 11) to unlock it.
The file is useless if copied to another PC or another user, committed to Git, or found in a backup. It does not protect against a
program that is already running as you (the same is true of Windows Credential Manager), and the secret is never on a command line,
in shell history, in source, in logs, or in browser code.

One-time setup on Windows (run in PowerShell as the same Windows user that will run ADRIAN; the secret is typed or pasted into a
hidden prompt, so it is not echoed and not saved in history):

```
$dir = Join-Path $env:LOCALAPPDATA 'ADRIAN'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Read-Host 'Bridge secret (hidden)' -AsSecureString | ConvertFrom-SecureString | Set-Content -Path (Join-Path $dir 'bridge-secret.dpapi')
```

Do not store it with `setx`, in a `.env` file, or in a script: those keep it in plain text. If ADRIAN obtains the secret some other
way, it can create the same file by replacing `Read-Host 'Bridge secret (hidden)' -AsSecureString` with
`ConvertTo-SecureString -String $value -AsPlainText -Force`, where `$value` is held only in ADRIAN's memory (never typed into a command).

Rules for every system: it can **never** be given on the command line; a plain-text secret file must be plain text (UTF-8) with only the
secret on one line, outside this Git repository, and (macOS/Linux) readable only by its owner; the secret is never printed, logged,
or written by this tool, and any text that echoes it back is redacted. It is only sent to `dragonoakstudio.com`,
`www.dragonoakstudio.com` or localhost. To point the command at a Vercel preview, name that exact host:

```
npm run etsy:sync -- --dry-run --site https://<preview-host> --trust-host <preview-host>
```

The site being asked must be running the storefront-v1 version of `/api/etsy-listings` (the one that understands
`?detail=full`); if it is not, the command stops and says so instead of reporting listings that all look SKU-less. Redirects
are never followed, so the secret cannot be forwarded to another address. Use `--file saved.json` to run the same report
offline from a saved response (no secret, no network).

To actually create draft catalog files from the listings later, use the separate importer (`npm run etsy:import`, with `--write`).

## Distributing to Etsy later

This phase is **read/import only**. A later phase can publish an approved catalog product to Etsy using the existing
protected create/upload/activate endpoints, taking the SKU, title, tags, description, price and images straight from
`catalog/products/<SKU>.json` so nothing is typed twice, then write the new listing ID back into the `etsy` block.
Digital files come from the `adrian:` reference, resolved inside ADRIAN, never from this repository.

## Why these are static files and not a database table or a new serverless function

- Vercel Hobby allows 12 serverless functions per deployment (each file in `api/` is one). The site already has 12.
- Preview deployments would share the live database. Files in Git give every preview its own safe copy of the catalog.
- Git history is the audit trail of every catalog change, and a preview is the review step.
