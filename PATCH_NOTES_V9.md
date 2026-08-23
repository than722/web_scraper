# v9 challenge scan patch

- Best Buy product-page fallback now continues through discovered links until `--max-items-per-store` usable products are collected, instead of stopping after a fixed number of attempts.
- Clearance/challenge/deals scans now run SoldComps against every usable scraped product in the scan, rather than only five.
- Normal scans retain the smaller SoldComps shortlist.
- Existing gross ROI, recent-sales, 2+ recent-comp preference, high-case warning, and UNVERIFIED verification behavior are unchanged.
