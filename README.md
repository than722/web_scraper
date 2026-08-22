# Iowa Flip Finder — Challenge-Focused Legal Public-Data Scraper

This project scans public retail product pages and compares prices across retailers with physical stores inside a **100-mile radius of Cedar Falls, Iowa**.

The goal is to surface **potential 50%+ gross price-spread opportunities** while being explicit about what still needs manual verification before a purchase.

## What the challenge version does

- Uses the supplied `data/stores.csv` as the source of local store locations.
- Calculates which listed stores fall inside the Cedar Falls 100-mile radius.
- Scrapes only public retail pages through Playwright and checks `robots.txt` before requesting search pages.
- Extracts product title, retailer SKU/product ID, price, rating/review count, and URL where available.
- Maps scraped chain results back to an actual store from the local CSV.
- Matches products using brand, model number, token similarity, and key-term overlap.
- Filters for a configurable 50%+ gross price spread.
- Adds a sellability score biased toward compact categories mentioned in the challenge (tools, electronics, small home items).
- Estimates a more conservative net return using configurable resale fees and shipping.
- Flags unusually large spreads for extra validation instead of presenting them as guaranteed flips.
- Produces a JSON report with a verification checklist.
- Supports `--challenge` mode to scan several high-value categories in one run.

## Important definition

The current `50%` threshold is a **gross price spread / return on purchase cost**:

```text
(comparison price - buy price) / buy price * 100
```

It is **not guaranteed net profit**. The report also calculates an estimated net return using the configured selling fee and shipping assumptions. Taxes, returns, and other marketplace costs are not included.

## Legal / verification approach

The scraper is designed around public information:

- no account login
- no private credentials
- no private API access
- no CAPTCHA bypass
- no anti-bot bypass
- checks `robots.txt` before accessing a search URL

A candidate is **not called a confirmed flip** automatically. The report labels local inventory as `manual_verification_required` and provides a checklist for confirming the exact SKU/model, local stock, comparison price, and resale costs.

## Setup

From PowerShell:

```powershell
npm install
npx playwright install chromium
```

The browser installation is required once because Playwright needs a Chromium executable.

## Normal scan

Example:

```powershell
npm run scan -- --query "cordless drill" --min-profit-pct 50 --top-n 5 --json-out output/report_drill.json
```

## Challenge scan

The challenge mode is designed around the actual assignment. By default it scans:

- cordless drill
- impact driver
- circular saw
- tool box
- bluetooth speaker
- desk lamp

Run:

```powershell
npm run scan -- --challenge --min-profit-pct 50 --top-n 10 --json-out output/challenge.json
```

`--challenge` automatically uses the widest available adapter set unless you explicitly choose a budget mode.

To focus the challenge scan on one category:

```powershell
npm run scan -- --challenge --category "cordless drill" --min-profit-pct 50 --top-n 5 --json-out output/challenge_drill.json
```

## Conservative resale assumptions

You can add a marketplace fee and shipping assumption:

```powershell
npm run scan -- --challenge --sell-fee-pct 15 --shipping-cost 8 --min-profit-pct 50 --json-out output/challenge_net.json
```

The report then contains both:

- `estimatedProfitPct` — gross price spread
- `estimatedNetProfitPct` — estimated return after the configured fee and shipping

## Re-running the same opportunity

For a clean demonstration that the software can find opportunities repeatedly, use a single query and save a report:

```powershell
npm run scan -- --query "cordless drill" --min-profit-pct 50 --top-n 5 --json-out output/run1.json
```

Then force fresh data:

```powershell
npm run scan -- --query "cordless drill" --min-profit-pct 50 --top-n 5 --refresh --json-out output/run2.json
```

Compare the reports. The same product may move in price or disappear because retail inventory and pricing are dynamic; that is expected for a live scraper.

## Current retailer coverage

The project contains adapters for several chains, but **an entry in `stores.csv` does not mean its website is automatically scrapeable**. The final report explicitly documents this distinction.

Current adapter targets include:

- Walmart
- Target
- Best Buy
- Harbor Freight
- Home Depot
- Lowe's
- Dollar General
- Ollie's
- Five Below
- TJ Maxx / Marshalls / Sierra
- Hobby Lobby
- Big Lots

Some chains can be blocked or change their page structure. The system does not bypass those protections; the store remains documented as coverage that needs an adapter.

## Output

Each candidate includes:

- product title
- buy retailer and local store address
- buy price
- buy SKU/product ID
- comparison retailer and local store
- comparison price
- comparison SKU/product ID
- gross price spread
- estimated net return
- similarity score
- confidence score
- sellability score
- local inventory verification status
- links for manual validation
- a verification checklist

## Suggested video demonstration

For the $300 challenge, demonstrate the following sequence:

1. Show `data/stores.csv` and explain the Cedar Falls 100-mile filter.
2. Run `--challenge` or a focused `cordless drill` scan.
3. Show a candidate at or above 50% gross spread.
4. Open both product URLs and manually confirm the exact model/package.
5. Show the candidate's local store information and explain that inventory is manually verified before purchase.
6. Run the same query again with `--refresh` to demonstrate repeatability.
7. Explain that the displayed 50% number is gross spread and that fees/shipping are also estimated separately.

This is deliberately more defensible than claiming that every online price gap is a guaranteed profit opportunity.
