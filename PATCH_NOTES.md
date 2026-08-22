# Best Buy scraper cleanup

This build restores the normal Best Buy search path and separates the Best Buy
adapter from the main scanner.

## What changed

- Normal `--query` Best Buy searches use the same public search endpoint that
  was working before the clearance changes.
- `--clearance` now discovers products through normal Best Buy searches for:
  `clearance`, `open box`, `deal`, `sale`, and `discount`.
- `--deals` uses the same deal-discovery searches.
- Direct Best Buy product-page navigation was removed from the specific-product
  flow because those `/product/.../openbox` pages were producing
  `ERR_HTTP2_PROTOCOL_ERROR`. `--best-buy-url` now extracts the SKU and searches
  Best Buy normally, then selects the exact SKU.
- The Best Buy adapter is now isolated in `src/adapters/bestbuy.js`.
- The old duplicated Best Buy scraping implementation was removed from
  `src/flip-finder.js`.
- Specific-product URLs now get their own cache key instead of sharing the
  generic empty-query cache.
- `.env`, `node_modules`, and generated output/cache files are intentionally not
  included so your existing credentials, dependencies, and results are not
  overwritten.

## Existing commands

Normal search:

    npm run scan -- --query "drill" --max-items-per-store 25 --min-profit-pct 50 --top-n 10 --json-out output/drill.json --refresh

Deal/clearance discovery:

    npm run scan -- --clearance --max-items-per-store 10 --min-profit-pct 50 --top-n 10 --json-out output/clearance-discovery.json --refresh

    npm run scan -- --deals --max-items-per-store 10 --min-profit-pct 50 --top-n 10 --json-out output/deals-discovery.json --refresh

Specific Best Buy URL:

    npm run scan -- --best-buy-url "https://www.bestbuy.com/product/..." --max-items-per-store 10 --min-profit-pct 50 --top-n 10 --json-out output/bestbuy-specific.json --refresh

The build passes `node --check` for both the main scanner and the Best Buy
adapter. The runtime test in this environment could not launch Chromium because
this environment does not have Playwright's browser binary installed; that is
an environment limitation, not a JavaScript syntax error.
