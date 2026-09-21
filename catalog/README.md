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

## Distributing to Etsy later

This phase is **read/import only**. A later phase can publish an approved catalog product to Etsy using the existing
protected create/upload/activate endpoints, taking the SKU, title, tags, description, price and images straight from
`catalog/products/<SKU>.json` so nothing is typed twice, then write the new listing ID back into the `etsy` block.
Digital files come from the `adrian:` reference, resolved inside ADRIAN, never from this repository.

## Why these are static files and not a database table or a new serverless function

- Vercel Hobby allows 12 serverless functions per deployment (each file in `api/` is one). The site already has 12.
- Preview deployments would share the live database. Files in Git give every preview its own safe copy of the catalog.
- Git history is the audit trail of every catalog change, and a preview is the review step.
