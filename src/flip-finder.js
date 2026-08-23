require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const { chromium } = require("playwright");

const {
  parseArgs,
  resolveBudgetProfile,
  getCachePath,
  readCache,
  writeCache,
  parseCsv,
  storesWithinRadius,
  CEDAR_FALLS,
  DEFAULT_RADIUS_MILES,
  SOURCE_TO_STORE_NAMES,
} = require("./config");

const { scanQuery } = require("./scanner");

console.log("SoldComps API key loaded:", Boolean(process.env.SOLDCOMPS_API_KEY));

function printCandidates(candidates, promisingLeads, nearMisses, topN, minProfitPct) {
  if (!candidates.length) {
    console.log(`No confirmed ${minProfitPct}%+ challenge candidates found.`);

    if (promisingLeads.length) {
      console.log(`\nPromising ${minProfitPct}%+ leads (manual verification required):`);

      for (let i = 0; i < Math.min(topN, promisingLeads.length); i += 1) {
        const n = promisingLeads[i];

        console.log(`${i + 1}. ${n.title}`);
        console.log(
          `   BUY:  ${n.buyStore} — $${n.buyPrice.toFixed(2)} — ${
            n.buyLocalStore?.city || "local source"
          }`
        );
        console.log(
          `   COMP: ${n.compStore} — $${n.compPrice.toFixed(2)} — ${n.comparisonType}`
        );
        console.log(
          `   Gross spread: ${Number(n.estimatedProfitPct ?? 0).toFixed(1)}% | Net ROI: ${
            Number(n.estimatedNetProfitPct ?? 0).toFixed(1)
          }% | Identity: ${Number(n.identityScore ?? 0).toFixed(0)}/100 | Confidence: ${
            (Number(n.confidence ?? 0) * 100).toFixed(0)
          }/100`
        );
        console.log(
          `   Signals: ${(n.identitySignals || []).join(", ") || "none"}`
        );
        console.log(`   Reason: ${n.reason}`);
        console.log(`   Buy:  ${n.buyUrl}`);
        console.log(`   Comp: ${n.compUrl}`);
      }
    }

    if (nearMisses.length) {
      console.log("\nClosest near-opportunities:");

      for (let i = 0; i < Math.min(topN, nearMisses.length); i += 1) {
        const n = nearMisses[i];

        console.log(`${i + 1}. ${n.title}`);
        console.log(
          `   BUY:  ${n.buyStore} — $${n.buyPrice.toFixed(2)} — ${
            n.buyLocalStore?.city || "local store"
          }`
        );
        console.log(
          `   COMP: ${n.compStore} — $${n.compPrice.toFixed(2)} — ${n.comparisonType}`
        );
        console.log(
          `   Gross spread: ${n.grossProfitPct.toFixed(1)}% | Similarity: ${
            n.similarity
          } | Key overlap: ${n.keyOverlap}`
        );
        console.log(`   Reason: ${n.reason}`);
      }
    }

    return;
  }

  for (let i = 0; i < Math.min(topN, candidates.length); i += 1) {
    const c = candidates[i];

    console.log(`${i + 1}. ${c.title}`);
    console.log(
      `   BUY:  ${c.buyStore} — $${c.buyPrice.toFixed(2)} — ${
        c.buyLocalStore?.city || "local store"
      } (${c.buyLocalStore?.distanceFromCedarFallsMiles ?? "?"} mi from Cedar Falls)`
    );
    console.log(
      `   COMP: ${c.compStore} — $${c.compPrice.toFixed(2)} — ${c.comparisonType}`
    );
    console.log(
      `   Model/SKU: ${c.model || "UNVERIFIED"} / ${c.buySku || "UNVERIFIED"}`
    );
    console.log(
      `   Retailer: ${c.retailer || c.buyStore || "UNVERIFIED"} | Buy price: $${Number(c.buyPrice ?? 0).toFixed(2)}`
    );
    console.log(
      `   Sold comp price(s): ${
        (c.soldCompPrices || [c.compPrice]).map((p) => `$${Number(p).toFixed(2)}`).join(", ")
      }`
    );
    console.log(
      `   Resale price used (highest valid recent sold): $${Number(c.compPrice ?? 0).toFixed(2)} | Gross profit: $${Number(c.grossProfit ?? ((c.compPrice ?? 0) - (c.buyPrice ?? 0))).toFixed(2)} | Gross ROI: ${Number(c.grossProfitPct ?? c.estimatedProfitPct ?? 0).toFixed(1)}%`
    );
    if (c.typicalSoldPrice !== undefined) {
      console.log(
        `   Typical sold price (median): $${Number(c.typicalSoldPrice).toFixed(2)} | Typical gross ROI: ${Number(c.typicalGrossProfitPct ?? 0).toFixed(1)}%`
      );
    }

    if (c.recentSales30d !== undefined) {
      console.log(
        `   Sales rate: ${c.recentSales30d} in 30d | ${c.recentSales14d ?? 0} in 14d | ${c.recentSales7d ?? 0} in 7d | ${Number(c.salesVelocityPerWeek ?? 0).toFixed(2)}/week`
      );
      console.log(
        `   Valid comps: ${c.soldCompCount ?? 0} | Recent valid comps: ${c.recentValidSoldComps ?? 0} | 2+ recent: ${c.preferredRecentComps ? "YES" : "NO"}`
      );
    }
    console.log(
      `   Identity: ${Number(c.identityScore ?? 0).toFixed(0)}/100 | Confidence: ${
        (Number(c.confidence ?? 0) * 100).toFixed(0)
      }/100 | Sellability: ${(Number(c.sellabilityScore ?? 0) * 100).toFixed(0)}/100`
    );
    console.log(
      `   Local inventory: ${c.localInventoryStatus || "UNVERIFIED — manual verification required"}`
    );
    console.log(
      `   Verification: ${c.verificationStatus || "UNVERIFIED"}`
    );

    if (c.suspiciousSpread) {
      console.log(
        `   WARNING: unusually large price spread; verify exact SKU/model/packaging.`
      );
    }
    if (c.highPriceWarning) {
      console.log(
        `   WARNING: selected high sold price is at least 50% above the typical median; treat the 70%+ ROI as a HIGH-CASE result and verify the exact sold listing.`
      );
    }

    console.log(`   Retail link: ${c.buyUrl || "UNVERIFIED"}`);
    if (Array.isArray(c.soldComps) && c.soldComps.length) {
      console.log("   Sold comp links:");
      for (const comp of c.soldComps) {
        console.log(`      - $${Number(comp.price).toFixed(2)} | ${comp.date ? new Date(comp.date).toISOString().slice(0, 10) : "date unverified"} | ${comp.condition || "condition unverified"} | ${comp.url || "URL UNVERIFIED"}`);
      }
    } else {
      console.log(`   Sold comp link: ${c.compUrl || "UNVERIFIED"}`);
    }
  }
}

async function run() {
  const args = parseArgs(process.argv);
  const budget = resolveBudgetProfile(args);
  const storesCsv = path.join(process.cwd(), "data", "stores.csv");
  const stores = parseCsv(storesCsv);
  const inRadius = storesWithinRadius(stores, DEFAULT_RADIUS_MILES);

  // ------------------------------------------------------------
  // SEARCH MODE
  //
  // Normal:
  //   --query "drill"
  //
  // Clearance:
  //   --clearance
  //
  // Clearance intentionally does NOT reuse args.query.
  // The Best Buy adapter will receive the special clearance
  // query/mode instead.
  // ------------------------------------------------------------

  const queries = args.bestBuyUrl
  ? ["__BESTBUY_SPECIFIC__"]
  : args.clearance
  ? ["__BESTBUY_CLEARANCE__"]
  : args.deals
  ? ["__BESTBUY_DEALS__"]
  : [args.query];

  const browser = await chromium.launch({ headless: !args.headed });
  const started = Date.now();
  const queryReports = [];

  try {
    for (const query of queries) {
      const cachePath = getCachePath(query);

      if (budget.useCache && !args.refresh) {
        const cached = readCache(cachePath, budget.cacheTtlMinutes);

        if (cached) {
          queryReports.push(cached);
          continue;
        }
      }

      const report = await scanQuery({
        args,
        budget,
        inRadius,
        browser,
        query,
      });

      queryReports.push(report);

      if (budget.useCache) {
        writeCache(cachePath, report);
      }
    }
  } finally {
    await browser.close();
  }

  const candidates = queryReports
    .flatMap(r => r.candidates || [])
    .sort(
      (a, b) =>
        ((b.grossProfitPct ?? b.estimatedProfitPct) - (a.grossProfitPct ?? a.estimatedProfitPct)) ||
        ((b.recentSales30d ?? 0) - (a.recentSales30d ?? 0)) ||
        (b.confidence - a.confidence)
    );

  const promisingLeads = queryReports
    .flatMap(r => r.promisingLeads || [])
    .sort(
      (a, b) =>
        ((b.grossProfitPct ?? b.estimatedProfitPct) - (a.grossProfitPct ?? a.estimatedProfitPct)) ||
        ((b.recentSales30d ?? 0) - (a.recentSales30d ?? 0)) ||
        (b.identityScore - a.identityScore) ||
        (b.confidence - a.confidence)
    )
    .slice(0, 20);

  const nearMisses = queryReports
    .flatMap(r => r.nearMisses || [])
    .sort((a, b) => b.grossProfitPct - a.grossProfitPct)
    .slice(0, 20);

  const diagnostics = queryReports.reduce((acc, r) => {
    for (const [k, v] of Object.entries(r.diagnostics || {})) {
      acc[k] = (acc[k] || 0) + Number(v || 0);
    }

    return acc;
  }, {});

  const scraperCounts = queryReports.reduce((acc, r) => {
    for (const [k, v] of Object.entries(r.scraperCounts || {})) {
      acc[k] = (acc[k] || 0) + Number(v || 0);
    }

    return acc;
  }, {});

  const storeFailures = queryReports.flatMap(
    r => r.storeFailures || []
  );

  const report = {
    generatedAt: new Date().toISOString(),

    // Show the real user-facing search mode in the report.
    queries: args.clearance
      ? ["BEST BUY CLEARANCE"]
      : args.deals
      ? ["BEST BUY DEALS"]
      : queries,

    clearanceMode: Boolean(args.clearance),
    dealsMode: Boolean(args.deals),
    challengeMode: Boolean(args.challenge || args.clearance || args.deals),
    minSales30d: args.minSales30d,

    radiusMiles: DEFAULT_RADIUS_MILES,

    center: {
      name: "Cedar Falls, IA",
      ...CEDAR_FALLS,
    },

    storesWithinRadius: inRadius,

    accessibleAdapters: Object.keys(SOURCE_TO_STORE_NAMES),

    coverageNote:
      "Best Buy public search pages are scraped only through URLs that pass the robots.txt check. No CAPTCHA or anti-bot bypass is used. A candidate's buy-side must map to a Best Buy store inside the 100-mile Cedar Falls radius.",

    productsScraped: queryReports.reduce(
      (n, r) => n + (r.productsScraped || 0),
      0
    ),

    productsWithLocalStore: queryReports.reduce(
      (n, r) => n + (r.productsWithLocalStore || 0),
      0
    ),

    storesAttempted: queryReports.reduce(
      (n, r) =>
        n + Object.keys(r.scraperCounts || {}).length,
      0
    ),

    storesSuccessful: queryReports.reduce(
      (n, r) =>
        n +
        Object.keys(r.scraperCounts || {}).filter(
          k => (r.scraperCounts[k] || 0) > 0
        ).length,
      0
    ),

    storesFailed: storeFailures.length,

    storeFailures,

    productCountsByAdapter: scraperCounts,

    matchingDiagnostics: diagnostics,

    nearMisses,

    promisingLeadCount: promisingLeads.length,

    promisingLeads,

    candidateCount: candidates.length,

    candidates,

    grossProfitDefinition:
      "gross profit = resale price - purchase price; gross ROI = gross profit / purchase price * 100.",
    netProfitDefinition:
      "((comparison price - buy price) - marketplace fee - shipping) / buy price * 100.",
    candidateThresholdDefinition:
      "min-profit-pct is applied to GROSS ROI using the highest valid recent sold price when at least two recent comps exist; the typical median sold price is reported separately so high-price evidence is visible rather than hidden.",
    salesRateDefinition:
      `Sales rate is the count of valid matching sold listings in the last 30 days. Challenge mode requires at least ${args.minSales30d} recent sales. Two or more recent valid sold comps are preferred when available.`,

    sourcePolicy:
      "robots.txt is checked before requests; 403/CAPTCHA/unknown robots are fail-closed.",

    hasSoldComps: queryReports.some(r => r.hasSoldComps === true),

    netProfitAssumptions: {
      sellFeePct: args.sellFeePct,
      shippingCost: args.shippingCost,
      note:
        "Taxes, returns and other marketplace costs are not included.",
    },

    verificationPolicy:
      "Candidates are not claimed as confirmed flips until local inventory and exact product identity are manually verified.",

    matchingPolicyNote:
      "The matching logic supports cross-retailer comparison. With only Best Buy as an adapter, same-retailer pairs are skipped — sold comps may still be used when available.",

    runtimeSec: Number(
      ((Date.now() - started) / 1000).toFixed(2)
    ),
  };

  console.log(
    `Searches: ${
      args.clearance
        ? "BEST BUY CLEARANCE"
        : args.deals
        ? "BEST BUY DEALS"
        : queries.join(", ")
    }`
  );

  console.log(
    `Cedar Falls radius: ${DEFAULT_RADIUS_MILES} miles`
  );

  console.log(
    `Stores in radius: ${inRadius.length}`
  );

  console.log(
    `Automated retailer adapters: ${
      Object.keys(scraperCounts).length
    }`
  );

  console.log(
    `Products scraped: ${report.productsScraped}`
  );

  console.log(
    `Local-store mapped products: ${
      report.productsWithLocalStore
    }`
  );

  const activeSources = Object.values(
    report.productCountsByAdapter || {}
  ).filter(n => n > 0).length;

  const hasRetailerSources = activeSources >= 2;
  const hasSoldComps = report.hasSoldComps === true;

  console.log(
    `Cross-source matching pool: ${
      hasRetailerSources || hasSoldComps
        ? "YES"
        : "NO"
    }`
  );

  console.log(
    `${args.minProfitPct}%+ gross ROI candidates: ${candidates.length}`
  );

  if (args.clearance || args.challenge || args.deals) {
    console.log(
      `Sales-rate gate: ${args.minSales30d}+ valid sold comps in the last 30 days`
    );
  }

  console.log(
    `Store failures: ${report.storesFailed}`
  );

  console.log("\nProducts by adapter:");

  for (
    const [source, count] of Object.entries(scraperCounts)
      .sort((a, b) => b[1] - a[1])
  ) {
    console.log(`  ${source}: ${count}`);
  }

  console.log("\nMatching diagnostics:");

  console.log(
    `  Pair checks: ${diagnostics.pairChecks || 0}`
  );

  console.log(
    `  Same retailer: ${diagnostics.sameRetailer || 0}`
  );

  console.log(
    `  Brand mismatch: ${diagnostics.brandMismatch || 0}`
  );

  console.log(
    `  Model mismatch: ${diagnostics.modelMismatch || 0}`
  );

  console.log(
    `  Similarity too low: ${diagnostics.similarityLow || 0}`
  );

  console.log(
    `  Key overlap too low: ${diagnostics.keyOverlapLow || 0}`
  );

  console.log(
    `  Price not higher: ${diagnostics.priceNotHigher || 0}`
  );

  console.log(
    `  Below ${args.minProfitPct}%: ${
      diagnostics.belowThreshold || 0
    }`
  );

  console.log(
    `  Sellability too low: ${
      diagnostics.sellabilityLow || 0
    }`
  );

  console.log(
    `  Confidence too low: ${
      diagnostics.confidenceLow || 0
    }`
  );

  console.log(
    `  Qualified: ${diagnostics.qualified || 0}`
  );

  console.log("\nSold-comp diagnostics:");

  console.log(
    `  Sold comp checks: ${
      diagnostics.soldCompChecks || 0
    }`
  );

  console.log(
    `  Sold comp matches: ${
      diagnostics.soldCompMatches || 0
    }`
  );

  console.log(
    `  Sold comp mismatches: ${
      diagnostics.soldCompMismatch || 0
    }`
  );

  console.log(
    `  Sold comp below threshold: ${
      diagnostics.soldCompBelowThreshold || 0
    }`
  );

  console.log(
    `  Sold comp qualified: ${
      diagnostics.soldCompQualified || 0
    }`
  );

  console.log(
    `Assumed resale fee: ${args.sellFeePct}% | shipping: $${args.shippingCost.toFixed(2)}`
  );

  console.log("\nTop candidates:");

  printCandidates(
    candidates,
    promisingLeads,
    nearMisses,
    args.topN,
    args.minProfitPct
  );

  if (args.jsonOut) {
    const outPath = path.isAbsolute(args.jsonOut)
      ? args.jsonOut
      : path.join(process.cwd(), args.jsonOut);

    fs.mkdirSync(path.dirname(outPath), {
      recursive: true,
    });

    fs.writeFileSync(
      outPath,
      JSON.stringify(report, null, 2),
      "utf8"
    );

    console.log(`\nSaved report: ${outPath}`);
  }
}


run().catch((err) => {
  console.error(err);
  process.exit(1);
});
