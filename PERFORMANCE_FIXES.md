# Performance fixes applied

1. Best Buy page wait reduced from 3.5s to 1.5s.
2. Best Buy extraction raw-card scan capped closer to the requested item count.
3. Sold-comps selection reduced to 4 products for normal searches and 6 for clearance/deals.
4. SoldComps requests run with max concurrency 2 instead of strictly serial requests.
5. SoldComps requests have a 15s default timeout (CLI override: `--sold-comp-timeout-ms`).
6. Successful sold-comp results are cached on disk under `output/cache/sold-comps/`, so repeat scans do not spend another API request for the same query.
7. `--sold-comp-products 0` disables sold comps for a fast scrape-only run.
8. `--sold-comp-products N` lets you choose 1-10 products.
9. `--sold-comp-concurrency 1-3` controls API concurrency.

The existing 45-request safety cap remains in place.
