# Iowa Flip Finder (Legal Public-Data Scraper)

This project scans public retail search pages for stores within 100 miles of Cedar Falls, IA,
then finds cross-store price gaps that can support 50%+ flip margins.

## What It Does

- Uses browser automation to gather public product data (title, price, SKU/ID, URL, reviews)
- Enforces a legal-first approach:
  - checks each search URL against `robots.txt`
  - no login walls, no private APIs, no bypass techniques
- Compares similar items across stores with fuzzy matching
- Flags candidates where estimated margin is at least 50%

## Current Store Adapters

- Walmart search pages
- Target search pages

The architecture is adapter-based so more stores can be added as they become scrape-accessible.
Some chains are behind strict bot protection from this environment.

## Setup

1. Install dependencies:

```powershell
npm install
npx playwright install chromium
```

2. Run a scan:

```powershell
npm run scan -- --query "cordless drill" --min-profit-pct 50 --top-n 5 --json-out output/report.json
```

### Budget Modes

- **`normal`** (default): Balanced scanning across Target, Best Buy, Harbor Freight, Home Depot, Lowe's, Ollie's, Five Below, and TJ Maxx/Marshalls/Sierra/Burlington/Ross.
- **`low`**: Cache-first (24-hour TTL), fewer items per store. Use when API credits are limited.
- **`aggressive`**: All stores including Walmart, Dollar General, Hobby Lobby, and Big Lots. No caching.

### Credit-Aware Mode (recommended when GitHub credits are high)

When your usage is high (for example 90%), run in low budget mode:

```powershell
npm run scan -- --query "drill" --credit-usage-pct 90 --budget-mode auto --json-out output/report_drill.json
```

What this does:

- Automatically switches to low-cost scan settings at 90%+ usage
- Uses cache-first behavior (24-hour TTL in low mode)
- Allows `--refresh` when you need live data instead of cache

Force a fresh run:

```powershell
npm run scan -- --query "drill" --credit-usage-pct 90 --budget-mode auto --refresh
```

### Aggressive Mode (full coverage)

To scan ALL stores for maximum opportunities:

```powershell
npm run scan -- --query "tool set" --budget-mode aggressive --min-profit-pct 50 --json-out output/report_full.json
```

### Category-Focused Scanning

Target specific high-margin categories:

```powershell
npm run scan -- --category "tools" --min-profit-pct 50
npm run scan -- --query "bluetooth speaker" --budget-mode aggressive
npm run scan -- --query "desk lamp" --budget-mode aggressive
```

### Example Queries

```powershell
npm run scan -- --query "cordless drill" --min-profit-pct 50 --top-n 5
npm run scan -- --query "circular saw" --budget-mode aggressive
npm run scan -- --query "bluetooth speaker" --budget-mode normal
npm run scan -- --query "tool box" --budget-mode aggressive --json-out output/report_tools.json
npm run scan -- --query "desk lamp" --budget-mode low --json-out output/report_lamps.json
```

## Output

The CLI prints top candidates with:

- buy store + buy price
- comp store + comp price
- estimated profit %
- confidence score
- links for validation

JSON output includes all candidates for later automation/listing workflows.

## Notes

- Profit math is:
  - `profit_pct = ((comp_price - buy_price) / buy_price) * 100`
- Confidence blends title similarity, rating signal, and review volume.
- To improve match quality, add UPC/GTIN extraction in each store adapter when available.
- `requirements.txt` and `src/flip_finder.py` are included as a Python prototype, but the runnable implementation in this environment is `src/flip-finder.js`.
