# Iowa Flip Finder v7 - Purple Wave adapter fix

Replace your existing `src/flip-finder.js` with the included file.

What changed:
- Keeps the robots.txt fail-closed behavior.
- Gives Purple Wave's public inventory page more time to hydrate.
- Uses category-specific public Iowa inventory pages for drill-related queries.
- Parses hydrated public auction links when available.
- Falls back to public JSON-LD ItemList data when present.
- Adds diagnostics when the page exposes an empty inventory shell.
- Does not bypass CAPTCHA, access controls, robots.txt, or private APIs.

Test:
npm run scan -- --query "drill" --scrape-friendly --max-items-per-store 25 --min-profit-pct 50 --top-n 10 --json-out output/local-drill.json --refresh


## Challenge evidence fields

Challenge/clearance results are evaluated with the required gross formula:

- Gross profit = resale price - purchase price
- Gross ROI = gross profit / purchase price x 100
- Minimum passing gross ROI = 70% (or the value supplied by `--min-profit-pct`)

Each confirmed candidate includes product name, model/SKU, retailer, buy price, the valid sold-comp prices used, gross profit, gross ROI, the retail URL, sold-comp URLs, and an explicit local-inventory verification status. The scraper does not claim local stock when it has only established that a matching retailer store exists within the search radius. Missing/uncertain model, SKU, condition, stock, or URL data is labeled `UNVERIFIED`.

The process is data-driven and repeats for whatever product/search results are discovered; no winning product is hardcoded.

## v8 challenge resale-price policy

In challenge mode, when at least two valid recent eBay sold comps exist, the official gross-ROI calculation uses the **highest valid recent sold price**. The report also shows the **median/typical sold price** and typical gross ROI so a high-price result is transparent rather than hidden.

If the selected high sold price is at least 50% above the typical median, the report labels it as a high-case result requiring verification.

Formula:
- Gross profit = resale price - purchase price
- Gross ROI = gross profit / purchase price * 100

Active eBay asking prices are not used as sold comps.
