# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Local Flip Finder** is a Node.js + Playwright web scraper that scans public retail search pages for products sold near Cedar Falls, IA (within a 100-mile radius), then identifies cross-store price gaps and eBay sold comps that could support 50%+ flip margins.

A parallel Python prototype (`src/flip_finder.py`) exists for Walmart and Target scraping using `playwright.sync_api`, but the primary active implementation is the Node.js version.

## Commands

```powershell
# Install dependencies
npm install
npx playwright install chromium

# Normal Best Buy search
npm run scan -- --query "drill" --max-items-per-store 25 --min-profit-pct 50 --top-n 10 --json-out output/drill.json --refresh

# Clearance mode (Best Buy outlet/clearance page)
npm run scan -- --clearance --max-items-per-store 25 --min-profit-pct 50 --top-n 10 --json-out output/clearance.json --refresh

# Deals mode (Top Deals + Deal of the Day + Clearance)
npm run scan -- --deals --max-items-per-store 25 --min-profit-pct 50 --top-n 10 --json-out output/deals.json --refresh

# Specific Best Buy product URL (extracts SKU, searches, selects exact SKU)
npm run scan -- --best-buy-url "https://www.bestbuy.com/product/..." --max-items-per-store 10 --json-out output/specific.json --refresh

# Show browser window (headed mode)
npm run scan -- --query "drill" --headed

# Enable debug snapshots (saves HTML + screenshots to output/debug/)
$env:FLIP_FINDER_DEBUG=1; npm run scan -- --query "drill" --refresh

# Validate JavaScript syntax
node --check src/flip-finder.js
node --check src/config.js
node --check src/scanner.js
node --check src/adapters/bestbuy.js
node --check src/adapters/ebay-sold.js
node --check src/matching/engine.js
node --check src/matching/candidates.js
node --check src/matching/text.js
node --check src/matching/sold.js
```

**Note:** `npm test` is not yet configured — it currently exits with an error.

## Environment

The `.env` file (not committed) must contain:

```
SOLDCOMPS_API_KEY=your_api_key_here
FLIP_FINDER_DEBUG=0
```

The SoldComps API key is required for eBay sold-comps lookups. Without it, the scraper logs a warning and skips sold comps (retailer-to-retailer comparison may still run, but with a single adapter that path is a no-op).

## Architecture

### High-Level Flow

```
CLI (flip-finder.js)
  → scanner.scanQuery()
    ├── adapters/bestbuy.js          ← scrapes Best Buy search/clearance/deals/specific
    ├── adapters/ebay-sold.js        ← queries SoldComps API for eBay sold listings
    ├── matching/text.js             ← attaches local store context to products
    └── matching/candidates.js
      ├── matching/engine.js          ← compareProducts() core identity/profit logic
      └── matching/sold.js            ← matchProductToSoldComp() for eBay comps
```

1. **Orchestration** (`src/flip-finder.js`): Parses CLI args, loads `data/stores.csv`, computes which stores fall within 100 miles of Cedar Falls (haversine), launches a Chromium browser, dispatches queries to `scanner.scanQuery()`, aggregates results across queries, prints a human-readable report, and optionally writes a JSON report to `output/`.

2. **Scanning** (`src/scanner.js`): For each query, runs enabled retailer scrapers, attaches local-store context (maps Best Buy products to the nearest in-radius store), selects representative products for sold-comps lookup, calls the eBay SoldComps API per product (with a 750ms delay between requests and a 45-request run cap), then calls `buildCandidates()` to produce flip candidates, promising leads, and near-misses.

3. **Matching** (`src/matching/`):
   - `engine.js` — `compareProducts()` is the core pairwise matcher. It checks same-retailer exclusion, buy-side radius, brand match, model match, condition compatibility, quantity/bundle mismatches, token-set title similarity, key-term overlap, price validity, gross profit threshold, sellability, and confidence. Returns a status of `qualified`, `lead`, `near`, or `reject` with a reason.
   - `candidates.js` — `buildCandidates()` runs O(n²) pairwise retailer comparisons then O(n×m) retailer-to-sold-comp comparisons, deduplicates results, and sorts by profit then confidence.
   - `text.js` — Pure text utilities: model number extraction (brand-specific patterns for Sony, DeWalt, Milwaukee, Makita, Bosch, Ryobi, plus general patterns), key-term extraction with stopword filtering, sellability classification, net-profit estimation, product text aggregation, category detection, and local store context attachment.
   - `sold.js` — `matchProductToSoldComp()` for eBay comps: brand matching, quantity extraction, model extraction, token-set similarity, and key-overlap scoring with relaxed thresholds.

4. **Adapters** (`src/adapters/`):
   - `bestbuy.js` — Full Best Buy scraper using Playwright. Handles the international country-selection page (multi-strategy US selection), progressive scrolling for lazy-loading, 5-strategy product-link collection (anchors, data-attributes, SKU elements, raw HTML regex, serialized SKU), listing-card extraction with title/price/image, and product-page fallback via JSON-LD with DOM fallback. Supports normal search, clearance, deals, and specific-SKU modes.
   - `ebay-sold.js` — SoldComps API client (`https://api.sold-comps.com/v1/scrape`). Caches results per run, enforces a 45-request daily cap, normalizes listing data (title, price, shipping, total, condition, seller info).

### Key Design Decisions

- **Robots.txt fail-closed**: `robotsAllowed()` in `config.js` checks robots.txt before requests. A 403 or fetch failure returns `true` in the Node.js adapter (fail-open for the network call), but Menards is expected to return 403 — see `PATCH_NOTES.md` / `PATCH_README.md` for context on previous patches.
- **Cache**: Query reports are cached to `output/cache/` with a 90-minute TTL. Use `--refresh` to bypass.
- **No anti-bot bypass**: The codebase explicitly avoids CAPTCHA bypass, Cloudflare challenges, proxies, stealth plugins, and authentication.
- **Manual verification is required**: Every candidate includes a `verificationChecklist` and `verificationStatus: "candidate_requires_local_inventory_and_listing_validation"`. No candidate is treated as a confirmed flip without manual checks.

### File Layout

```
src/
  flip-finder.js        ← CLI orchestrator, report output, cache management
  config.js             ← Args, cache, CSV parsing, radius utils, robots, shared helpers
  scanner.js            ← Scan pipeline: scrape → local context → sold comps → candidates
  adapters/
    bestbuy.js          ← Best Buy scraper (search/clearance/deals/specific)
    ebay-sold.js        ← SoldComps API adapter
  matching/
    engine.js           ← compareProducts() core matcher
    candidates.js       ← buildCandidates() orchestrator
    text.js             ← Text extraction & classification utilities
    sold.js             ← matchProductToSoldComp() for eBay comps
    index.js            ← Barrel re-export
data/
  stores.csv            ← Retailer/store list with addresses (no lat/lon — falls back to city centroids)
output/                 ← Reports and cache (gitignored)
```

### Debug Artifacts

Set `FLIP_FINDER_DEBUG=1` to save full HTML snapshots and screenshots to `output/debug/` for diagnosing scraper issues. Debug artifacts already exist from previous runs (e.g., `tjx-tool-set.html`, `target-drill.html`).
