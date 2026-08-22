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
