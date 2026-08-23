# Patch v11 — adaptive Best Buy product fallback

## Fix

v10 bounded Best Buy fallback to a small batch, but that batch could still be
too small when the clearance listing exposed many product URLs whose pages did
not yield usable product data.

v11 changes the fallback semantics so `--max-items-per-store N` means:

> collect up to N usable products

rather than:

> inspect only N-ish product pages.

### Changes

- Keeps listing-card extraction first.
- If fewer than `maxItems` usable products are found, the scraper continues
  through additional product URLs.
- Uses an adaptive fallback budget based on the number of products still
  needed.
- Hard-caps fallback navigation at 24 product pages.
- Keeps the per-page navigation timeout bounded at 6 seconds.
- Keeps locator/default timeout bounded at 4 seconds.
- Logs the fallback target, recovered products, pages visited, and final
  usable-product count.
- Stops immediately once `maxItems` usable products are recovered.
- Does not change SoldComps, matching, ROI, or candidate-selection logic.

## Expected clearance behavior

For a clearance page with 76 discovered product links and only 4 products
available from listing-card extraction, a scan with:

`--max-items-per-store 10`

can now continue past the first fallback batch and attempt enough additional
pages to recover up to 10 usable products, while never crawling more than 24
fallback product pages.
