# Patch v10 — bounded Best Buy fallback

## Fix
The v9 Best Buy product-page fallback could walk all remaining discovered links
until `--max-items-per-store` was filled. On a clearance page with many links,
this could make a scan appear stuck for several minutes.

v10 changes the fallback to:
- try only a bounded number of additional product pages;
- use a maximum fallback budget based on the number of products still needed;
- cap navigation at 7 seconds;
- cap Playwright locator operations at 5 seconds;
- close each fallback page in `finally`;
- stop immediately once `maxItems` is reached.

The sold-comps coverage change from v9 is preserved: clearance/challenge/deals
scans evaluate all successfully scraped products rather than an arbitrary
3-product shortlist.

## Expected behavior
A clearance scan that discovers 76 links but extracts 4 products from listing
cards will now try a limited additional batch instead of potentially visiting
all 72 remaining links.
