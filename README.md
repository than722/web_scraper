# Local Flip Finder

A modular Node.js + Playwright scraper for public retail product pages and resale-comparison analysis.

## Best Buy

The Best Buy adapter is now isolated in `src/adapters/bestbuy.js`.

### Normal search

```powershell
npm run scan -- --query "drill" --max-items-per-store 10 --min-profit-pct 50 --top-n 10 --json-out output/drill-test.json --refresh
```

### Clearance

`--clearance` now uses Best Buy's actual Clearance Electronics Outlet page:

`https://www.bestbuy.com/site/outlet-refurbished-clearance/clearance-electronics/pcmcat748300666044.c?id=pcmcat748300666044`

```powershell
npm run scan -- --clearance --max-items-per-store 10 --min-profit-pct 50 --top-n 10 --json-out output/clearance-test.json --refresh
```

### Deals

```powershell
npm run scan -- --deals --max-items-per-store 10 --min-profit-pct 50 --top-n 10 --json-out output/deals-test.json --refresh
```

Deals mode checks Top Deals, Deal of the Day, and the Best Buy Clearance page.

### Specific Best Buy URL

The scraper extracts the SKU from the supplied URL and searches Best Buy for that SKU instead of directly navigating to the fragile `/openbox` product endpoint.

```powershell
npm run scan -- --best-buy-url "https://www.bestbuy.com/product/lenovo-ideapad-slim-3i-15-6-full-hd-laptop-intel-core-i3-n305-2023-8gb-memory-128gb-storage-arctic-grey/6610891/openbox?condition=fair" --max-items-per-store 10 --min-profit-pct 50 --top-n 10 --json-out output/bestbuy-lenovo.json --refresh
```

## Project layout

- `src/flip-finder.js` — small CLI/orchestrator and final report output
- `src/config.js` — CLI arguments, cache, store/radius utilities, shared helpers
- `src/scanner.js` — scan pipeline and retailer orchestration
- `src/adapters/bestbuy.js` — all Best Buy scraping logic
- `src/adapters/ebay-sold.js` — sold-comps API adapter
- `src/matching/text.js` — product text, identifiers, categories, sellability
- `src/matching/engine.js` — product identity and profit matching
- `src/matching/sold.js` — sold-comparable matching helpers
- `src/matching/candidates.js` — candidate construction and diagnostics
- `src/matching/index.js` — matching module exports
- `data/stores.csv` — local store data

## Setup

1. Keep your existing `.env` in the project root. Do not replace it with `.env.example`.
2. Install dependencies if needed:

```powershell
npm install
npx playwright install chromium
```

3. Run one of the commands above.

The ZIP intentionally does **not** include `node_modules`, `.venv`, `.git`, generated output reports, or your `.env` credentials.
