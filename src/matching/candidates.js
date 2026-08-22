const { normalize } = require("../config");
const { compareProducts } = require("./engine");
const { matchProductToSoldComp } = require("./sold");

function buildCandidates(products, minProfitPct, options = {}) {
  const diagnostics = {
    pairChecks: 0,
    sameRetailer: 0,
    buyOutsideRadius: 0,
    brandMismatch: 0,
    modelMismatch: 0,
    modelMatches: 0,
    similarityLow: 0,
    keyOverlapLow: 0,
    priceNotHigher: 0,
    belowThreshold: 0,
    sellabilityLow: 0,
    confidenceLow: 0,
    qualified: 0,

    // Sold-comp diagnostics
    soldCompChecks: 0,
    soldCompMatches: 0,
    soldCompMismatch: 0,
    soldCompBelowThreshold: 0,
    soldCompQualified: 0,
  };

  const soldComps = Array.isArray(options.soldComps)
    ? options.soldComps
    : [];

  const nearMisses = [];
  const leads = [];
  const out = [];

  const seenNear = new Set();
  const seenLead = new Set();

  /*
   * ------------------------------------------------------------
   * 1. EXISTING RETAILER -> RETAILER COMPARISON
   * ------------------------------------------------------------
   *
   * Keep the existing logic intact.
   */
  for (let i = 0; i < products.length; i += 1) {
    for (let j = 0; j < products.length; j += 1) {
      if (i === j) continue;

      diagnostics.pairChecks++;

      const result = compareProducts(
        products[i],
        products[j],
        minProfitPct,
        options,
        diagnostics
      );

      if (result.status === "qualified") {
        out.push(result.row);
      }

      if (result.status === "lead") {
        const lead = result.lead;

        const key =
          `${normalize(lead.title)}|` +
          `${lead.buyStore}|` +
          `${lead.compStore}`;

        if (!seenLead.has(key)) {
          seenLead.add(key);
          leads.push(lead);
        }
      }

      if (result.status === "near") {
        const buy = products[i];
        const comp = products[j];

        const key =
          `${normalize(buy.title)}|` +
          `${buy.storeName}|` +
          `${comp.storeName}`;

        if (!seenNear.has(key)) {
          seenNear.add(key);

          nearMisses.push({
            title: buy.title,
            buyStore: buy.storeName,
            buyPrice: buy.price,
            buyUrl: buy.url,
            buyLocalStore: buy.localStore,

            compStore: comp.storeName,
            compPrice: comp.price,
            compUrl: comp.url,

            comparisonType:
              comp.localStoreFound
                ? "local_retailer"
                : "public_online_price",

            grossProfitPct:
              Number(result.grossProfitPct.toFixed(2)),

            similarity:
              Number(result.similarity.toFixed(3)),

            keyOverlap:
              Number((result.overlapRatio || 0).toFixed(3)),

            modelMatch:
              Boolean(result.modelMatch),

            reason: result.reason,
          });
        }
      }
    }
  }

  /*
   * ------------------------------------------------------------
   * 2. LOCAL RETAILER -> EBAY SOLD COMPS
   * ------------------------------------------------------------
   *
   * This is the new step.
   *
   * A retailer product is the BUY side.
   * A completed eBay transaction is the SELL side.
   */
  for (const product of products) {
    if (!product) continue;

    /*
     * Only use products that actually represent a local
     * purchasing opportunity.
     */
    if (
      !product.localStoreFound ||
      !product.localStore?.withinCedarFallsRadius
    ) {
      diagnostics.buyOutsideRadius++;
      continue;
    }

    if (!Number.isFinite(Number(product.price)) || product.price <= 0) {
      continue;
    }

    for (const comp of soldComps) {
      diagnostics.soldCompChecks++;

      const match = matchProductToSoldComp(product, comp);

      if (!match.matches) {
        diagnostics.soldCompMismatch++;
        continue;
      }

      diagnostics.soldCompMatches++;

      const buyPrice = Number(product.price);
      const soldPrice = Number(
        comp.totalPrice ?? comp.soldPrice ?? comp.price
      );

      if (!Number.isFinite(soldPrice) || soldPrice <= 0) {
        continue;
      }

      /*
       * eBay fees.
       *
       * We use the existing configured sell fee.
       */
      const sellFeePct =
        Number.isFinite(Number(options.sellFeePct))
          ? Number(options.sellFeePct)
          : 15;

      const shippingCost =
        Number.isFinite(Number(options.shippingCost))
          ? Number(options.shippingCost)
          : 0;

      const ebayFee =
        soldPrice * (sellFeePct / 100);

      const estimatedProfit =
        soldPrice -
        ebayFee -
        shippingCost -
        buyPrice;

      const estimatedProfitPct =
        buyPrice > 0
          ? (estimatedProfit / buyPrice) * 100
          : 0;

      /*
       * Confidence is based on how well the retailer item
       * matches the sold listing.
       */
      const confidence =
        typeof match.confidence === "number"
          ? match.confidence
          : 0;

      /*
       * If the sold price doesn't produce the requested
       * profit threshold, keep it as a near miss.
       */
      if (estimatedProfitPct < minProfitPct) {
        diagnostics.soldCompBelowThreshold++;

        const nearKey =
          `${normalize(product.title)}|` +
          `${product.storeName}|` +
          `${comp.itemId || comp.url || comp.title}`;

        if (!seenNear.has(nearKey)) {
          seenNear.add(nearKey);

          nearMisses.push({
            title: product.title,

            buyStore: product.storeName,
            buyPrice,
            buyUrl: product.url,
            buyLocalStore: product.localStore,

            compStore: "eBay Sold",
            compPrice: soldPrice,
            compUrl: comp.url,

            comparisonType: "ebay_sold",

            soldCompTitle: comp.title,
            soldCompCondition: comp.condition || null,
            soldCompDate: comp.endedAt || comp.soldDate || null,

            ebayFee,
            shippingCost,
            estimatedProfit:
              Number(estimatedProfit.toFixed(2)),
            grossProfitPct:
              Number(estimatedProfitPct.toFixed(2)),

            similarity:
              Number((match.similarity || 0).toFixed(3)),

            keyOverlap:
              Number((match.overlapRatio || 0).toFixed(3)),

            modelMatch:
              Boolean(match.modelMatch),

            confidence:
              Number(confidence.toFixed(3)),

            reason:
              "Sold comp does not meet minimum profit threshold",
          });
        }

        continue;
      }

      /*
       * --------------------------------------------------------
       * QUALIFIED SOLD-COMP CANDIDATE
       * --------------------------------------------------------
       */
      diagnostics.soldCompQualified++;
      diagnostics.qualified++;

      const row = {
        title: product.title,

        buyStore: product.storeName,
        buyPrice,
        buyUrl: product.url,
        buySku: product.sku || null,
        buyLocalStore: product.localStore || null,

        compStore: "eBay",
        compPrice: soldPrice,
        compUrl: comp.url || null,

        comparisonType: "ebay_sold",

        /*
         * Sold-comp information
         */
        soldCompTitle: comp.title,
        soldCompItemId: comp.itemId || null,
        soldCompCondition: comp.condition || null,
        soldCompDate: comp.endedAt || comp.soldDate || null,

        /*
         * Economics
         */
        sellFeePct,
        sellFee: Number(ebayFee.toFixed(2)),
        shippingCost,

        estimatedProfit:
          Number(estimatedProfit.toFixed(2)),

        estimatedProfitPct:
          Number(estimatedProfitPct.toFixed(2)),

        /*
         * Matching information
         */
        similarity:
          Number((match.similarity || 0).toFixed(3)),

        keyOverlap:
          Number((match.overlapRatio || 0).toFixed(3)),

        modelMatch:
          Boolean(match.modelMatch),

        identityScore:
          Number(
            (match.identityScore || 0).toFixed(3)
          ),

        confidence:
          Number(confidence.toFixed(3)),

        /*
         * eBay seller information if available
         */
        sellerUsername:
          comp.sellerUsername || null,

        sellerPositivePercent:
          comp.sellerPositivePercent ?? null,

        sellerFeedbackScore:
          comp.sellerFeedbackScore ?? null,

        itemLocation:
          comp.itemLocation || null,
      };

      out.push(row);
    }
  }

  /*
   * ------------------------------------------------------------
   * DEDUPLICATE QUALIFIED CANDIDATES
   * ------------------------------------------------------------
   */
  const dedup = new Map();

  for (const row of out) {
    const key =
      `${normalize(row.title)}|` +
      `${row.buyStore}|` +
      `${row.compStore}|` +
      `${row.comparisonType}`;

    const current = dedup.get(key);

    if (
      !current ||
      row.estimatedProfitPct > current.estimatedProfitPct
    ) {
      dedup.set(key, row);
    }
  }

  const candidates =
    Array.from(dedup.values()).sort(
      (a, b) =>
        (b.estimatedProfitPct - a.estimatedProfitPct) ||
        (b.confidence - a.confidence)
    );

  /*
   * Sort near misses.
   */
  nearMisses.sort(
    (a, b) =>
      (b.grossProfitPct || 0) -
      (a.grossProfitPct || 0)
  );

  /*
   * Sort leads.
   */
  leads.sort(
    (a, b) =>
      (b.estimatedProfitPct - a.estimatedProfitPct) ||
      (b.identityScore - a.identityScore) ||
      (b.confidence - a.confidence)
  );

  return {
    candidates,

    leads: leads.slice(0, 20),

    diagnostics,

    nearMisses: nearMisses.slice(0, 10),
  };
}


module.exports = { buildCandidates };
