# Iowa Flip Finder - Local Inventory Fix v5

This patch is based on v4 and addresses the latest run.

## Important finding
- Menards Store Bargains is still returning HTTP 403 from robots.txt. The adapter remains fail-closed and does NOT bypass that restriction. A 403 is therefore expected to produce zero Menards products.
- Purple Wave's Iowa inventory is publicly accessible, but the previous parser only matched the visible auction-link title. Purple Wave can use generic card titles such as "Tools" while the actual make/model appears in the card description. The parser now evaluates the whole public item card and extracts the most descriptive title available.

## Purple Wave changes
- Walks up to 10 DOM ancestors.
- Looks for a dollar price and an Iowa city.
- Matches query tokens against the entire public item card, not only the anchor text.
- Extracts headings/title-like elements from the item card when available.
- Deduplicates by auction URL/title as before.
- Keeps the 10% buyer premium calculation.

## Robots / access
No CAPTCHA, Cloudflare, proxy, stealth, authentication, or robots bypass is included.

## Test
npm run scan -- --query "drill" --scrape-friendly --max-items-per-store 25 --min-profit-pct 50 --top-n 10 --json-out output/local-drill.json --refresh

Use `drill` instead of `cordless drill` for this source-validation test because the current public Purple Wave Iowa inventory can contain core drills, concrete drills, or tool lots that do not literally contain the word "cordless".
