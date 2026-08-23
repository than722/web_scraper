const { normalize } = require("../config");
const { compareProducts, identityScore } = require("./engine");
const { classifySellability, netProfitEstimate, toConfidence, productCategory, productText } = require("./text");
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
   * For the challenge we treat sold comps as market evidence,
   * not as one-off price points. A product qualifies from eBay
   * only when its valid recent sold comps support the requested
   * GROSS ROI and the configured sales velocity.
   */
  const minSales30d = Number.isFinite(Number(options.minSales30d))
    ? Math.max(0, Number(options.minSales30d))
    : 3;

  const challengeMode = options.challengeMode === true;

  function parseSoldDate(comp) {
    const value = comp?.endedAt || comp?.soldDate || comp?.soldAt || null;
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function median(values) {
    const nums = values
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2
      ? nums[mid]
      : (nums[mid - 1] + nums[mid]) / 2;
  }

  function isBadSoldCondition(comp) {
    const condition = String(comp?.condition || "").toLowerCase();
    return [
      "parts only",
      "for parts",
      "not working",
      "broken",
      "repair",
      "salvage",
    ].some((bad) => condition.includes(bad));
  }

  function soldCompBelongsToProduct(product, comp) {
    // The scanner tags every SoldComps result with the product that
    // generated the search. Prefer those tags so one product's eBay
    // results cannot accidentally qualify another product.
    if (product.sku && comp.matchedSourceSku) {
      return String(product.sku) === String(comp.matchedSourceSku);
    }

    if (product.model && comp.matchedSourceModel) {
      return String(product.model).toLowerCase() === String(comp.matchedSourceModel).toLowerCase();
    }

    if (comp.matchedSourceProduct) {
      return normalize(product.title) === normalize(comp.matchedSourceProduct);
    }

    // Backward-compatible fallback for untagged comps.
    return true;
  }

  for (const product of products) {
    if (!product) continue;

    if (
      !product.localStoreFound ||
      !product.localStore?.withinCedarFallsRadius
    ) {
      diagnostics.buyOutsideRadius++;
      continue;
    }

    if (!Number.isFinite(Number(product.price)) || Number(product.price) <= 0) {
      continue;
    }

    const productComps = soldComps.filter((comp) =>
      soldCompBelongsToProduct(product, comp)
    );

    if (!productComps.length) continue;

    const validMatches = [];

    for (const comp of productComps) {
      diagnostics.soldCompChecks++;

      if (isBadSoldCondition(comp)) {
        diagnostics.soldCompMismatch++;
        continue;
      }

      const match = matchProductToSoldComp(product, comp);

      if (!match.matches) {
        diagnostics.soldCompMismatch++;
        continue;
      }

      const soldPrice = Number(
        comp.totalPrice ?? comp.soldPrice ?? comp.price
      );

      if (!Number.isFinite(soldPrice) || soldPrice <= 0) {
        continue;
      }

      diagnostics.soldCompMatches++;
      validMatches.push({ comp, match, soldPrice, date: parseSoldDate(comp) });
    }

    if (!validMatches.length) continue;

    const now = new Date();
    const cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentMatches = validMatches.filter((x) => x.date && x.date >= cutoff30d && x.date <= now);

    const recentSales30d = recentMatches.length;
    const recentSales14d = recentMatches.filter(
      (x) => x.date >= new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
    ).length;
    const recentSales7d = recentMatches.filter(
      (x) => x.date >= new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    ).length;

    const salesVelocityPerWeek = Number(((recentSales30d / 30) * 7).toFixed(2));
    const lastSoldDate = validMatches
      .map((x) => x.date)
      .filter(Boolean)
      .sort((a, b) => b - a)[0] || null;

    // Pricing policy for the challenge:
    // - Use recent valid sold comps when at least two are available.
    // - The official challenge resale price is the HIGHEST valid recent
    //   sold price, because the task asks whether the item can achieve
    //   >= 70% gross ROI.
    // - Also calculate the median recent price so the report exposes the
    //   typical market level instead of hiding a high-price outlier.
    // - If fewer than two recent comps exist, fall back to all valid comps
    //   and clearly label that evidence as limited.
    const pricingMatches = recentMatches.length >= 2
      ? recentMatches
      : validMatches;

    const typicalSoldPrice = median(
      pricingMatches.map((x) => x.soldPrice)
    );

    const highestSoldMatch = pricingMatches
      .slice()
      .sort((a, b) => b.soldPrice - a.soldPrice)[0];

    const resalePrice = highestSoldMatch?.soldPrice;

    if (!Number.isFinite(resalePrice) || resalePrice <= 0 ||
        !Number.isFinite(typicalSoldPrice) || typicalSoldPrice <= 0) continue;

    const buyPrice = Number(product.price);

    // Challenge formula (intentionally gross, before eBay fees/shipping):
    // gross profit = resale price - purchase price
    // gross ROI    = gross profit / purchase price * 100
    const grossProfit = resalePrice - buyPrice;
    const grossProfitPct = buyPrice > 0
      ? (grossProfit / buyPrice) * 100
      : 0;

    const typicalGrossProfit = typicalSoldPrice - buyPrice;
    const typicalGrossProfitPct = buyPrice > 0
      ? (typicalGrossProfit / buyPrice) * 100
      : 0;

    const highVsTypicalRatio = typicalSoldPrice > 0
      ? resalePrice / typicalSoldPrice
      : null;

    const highPriceWarning = Number.isFinite(highVsTypicalRatio) &&
      highVsTypicalRatio >= 1.5;

    const sellFeePct = Number.isFinite(Number(options.sellFeePct))
      ? Number(options.sellFeePct)
      : 15;
    const shippingCost = Number.isFinite(Number(options.shippingCost))
      ? Number(options.shippingCost)
      : 0;

    const net = netProfitEstimate(
      buyPrice,
      resalePrice,
      sellFeePct,
      shippingCost
    );

    const representative = highestSoldMatch;

    const representativeComp = representative.comp;
    const representativeMatch = representative.match;

    const confidence = toConfidence(
      Number(representativeMatch.similarity || 0),
      product.rating,
      product.reviewCount,
      Boolean(representativeMatch.modelMatch)
    );

    const buyCategory = productCategory(productText(product));
    const compCategory = productCategory(productText(representativeComp));
    const categoryMatch = Boolean(
      buyCategory && compCategory && buyCategory === compCategory
    );

    const identity = identityScore(
      product,
      {
        ...representativeComp,
        source: "ebay_sold",
        listingType: "sold",
      },
      Number(representativeMatch.similarity || 0),
      Number(representativeMatch.overlapRatio || 0),
      Boolean(representativeMatch.modelMatch),
      categoryMatch
    );

    const sellability = classifySellability(productText(product), buyPrice);

    const hasPreferredRecentComps = recentMatches.length >= 2;
    const salesGatePass = !challengeMode || recentSales30d >= minSales30d;
    const roiGatePass = grossProfitPct >= minProfitPct;

    if (!roiGatePass || !salesGatePass) {
      diagnostics.soldCompBelowThreshold++;

      const nearKey = `${normalize(product.title)}|${product.storeName}|${representativeComp.itemId || representativeComp.url || representativeComp.title}`;
      if (!seenNear.has(nearKey)) {
        seenNear.add(nearKey);
        nearMisses.push({
          title: product.title,
          buyStore: product.storeName || "Best Buy",
          buyPrice,
          buyUrl: product.url,
          buyLocalStore: product.localStore,
          compStore: "eBay Sold",
          compPrice: Number(resalePrice.toFixed(2)),
          compUrl: representativeComp.url || null,
          comparisonType: "ebay_sold",
          soldCompTitle: representativeComp.title,
          soldCompCondition: representativeComp.condition || null,
          soldCompDate: representativeComp.endedAt || representativeComp.soldDate || null,
          grossProfitPct: Number(grossProfitPct.toFixed(2)),
          typicalGrossProfitPct: Number(typicalGrossProfitPct.toFixed(2)),
          typicalSoldPrice: Number(typicalSoldPrice.toFixed(2)),
          highPriceWarning,
          estimatedNetProfitPct: Number(net.netPct.toFixed(2)),
          grossProfit: Number(grossProfit.toFixed(2)),
          estimatedProfit: Number(net.net.toFixed(2)),
          recentSales7d,
          recentSales14d,
          recentSales30d,
          salesVelocityPerWeek,
          validSoldComps: validMatches.length,
          recentValidSoldComps: recentMatches.length,
          hasPreferredRecentComps,
          confidence: Number(confidence.toFixed(3)),
          identityScore: Number(identity.score.toFixed(3)),
          similarity: Number((representativeMatch.similarity || 0).toFixed(3)),
          keyOverlap: Number((representativeMatch.overlapRatio || 0).toFixed(3)),
          reason: !roiGatePass
            ? "Highest valid recent sold price does not meet the minimum gross ROI"
            : `Sales velocity below minimum: ${recentSales30d} sold in the last 30 days; minimum is ${minSales30d}`,
        });
      }
      continue;
    }

    // Challenge mode requires the product to have enough recent sales.
    // The assignment says to prefer at least two recent comps; record that
    // explicitly rather than treating one comp as equally strong evidence.
    diagnostics.soldCompQualified++;
    diagnostics.qualified++;

    out.push({
      title: product.title,
      buyStore: product.storeName || "Best Buy",
      buyPrice,
      buyUrl: product.url,
      buySku: product.sku || null,
      model: product.model || null,
      buyLocalStore: product.localStore || null,
      compStore: "eBay",
      compPrice: Number(resalePrice.toFixed(2)),
      compUrl: representativeComp.url || null,
      comparisonType: "ebay_sold",
      soldCompTitle: representativeComp.title,
      soldCompItemId: representativeComp.itemId || null,
      soldCompCondition: representativeComp.condition || null,
      soldCompDate: representativeComp.endedAt || representativeComp.soldDate || null,
      // Required challenge evidence: preserve every valid pricing comp used,
      // including its price, date, condition and URL.
      soldCompPrices: pricingMatches.map((x) => Number(x.soldPrice.toFixed(2))),
      selectedResalePrice: Number(resalePrice.toFixed(2)),
      typicalSoldPrice: Number(typicalSoldPrice.toFixed(2)),
      typicalGrossProfit: Number(typicalGrossProfit.toFixed(2)),
      typicalGrossProfitPct: Number(typicalGrossProfitPct.toFixed(2)),
      highPriceWarning,
      highVsTypicalRatio: Number.isFinite(highVsTypicalRatio) ? Number(highVsTypicalRatio.toFixed(2)) : null,
      soldComps: pricingMatches.map((x) => ({
        price: Number(x.soldPrice.toFixed(2)),
        date: x.date ? x.date.toISOString() : null,
        condition: x.comp.condition || null,
        title: x.comp.title || null,
        url: x.comp.url || null,
        itemId: x.comp.itemId || null,
      })),
      soldCompCount: validMatches.length,
      recentValidSoldComps: recentMatches.length,
      recentSales7d,
      recentSales14d,
      recentSales30d,
      salesVelocityPerWeek,
      lastSoldDate: lastSoldDate ? lastSoldDate.toISOString() : null,
      preferredRecentComps: hasPreferredRecentComps,
      sellFeePct,
      sellFee: Number((resalePrice * (sellFeePct / 100)).toFixed(2)),
      shippingCost,
      // Required challenge fields. These are deliberately independent of
      // the optional net-profit estimate below.
      grossProfit: Number(grossProfit.toFixed(2)),
      estimatedProfit: Number(net.net.toFixed(2)),
      estimatedProfitPct: Number(grossProfitPct.toFixed(2)),
      grossProfitPct: Number(grossProfitPct.toFixed(2)),
      estimatedNetProfitPct: Number(net.netPct.toFixed(2)),
      netProfit: Number(net.net.toFixed(2)),
      similarity: Number((representativeMatch.similarity || 0).toFixed(3)),
      keyOverlap: Number((representativeMatch.overlapRatio || 0).toFixed(3)),
      modelMatch: Boolean(representativeMatch.modelMatch),
      confidence: Number(confidence.toFixed(3)),
      identityScore: Number(identity.score.toFixed(3)),
      identitySignals: identity.signals,
      sellabilityScore: sellability.score,
      sellabilityReason: sellability.reason,
      categoryMatch,
      sellerUsername: representativeComp.sellerUsername || null,
      sellerPositivePercent: representativeComp.sellerPositivePercent ?? null,
      sellerFeedbackScore: representativeComp.sellerFeedbackScore ?? null,
      suspiciousSpread: grossProfitPct > 300,
      retailer: product.storeName || "Best Buy",
      localInventoryStatus: product.localStoreFound && product.localStore?.withinCedarFallsRadius
        ? "UNVERIFIED — a matching retailer store is within the search radius; actual in-stock inventory was not verified by the scraper"
        : "UNVERIFIED — local store/in-stock status could not be verified",
      localAvailability: "UNVERIFIED",
      verificationStatus: "UNVERIFIED — exact local stock and physical unit availability require manual verification",
      itemLocation: representativeComp.itemLocation || null,
      salesRateDefinition: "valid matching sold listings in the last 30 days",
      resalePriceDefinition: recentMatches.length >= 2
        ? "highest valid matching sold listing from the last 30 days; typical market price is reported separately as the median"
        : "highest valid matching sold listing from all available valid comps because fewer than 2 recent comps were available; limited evidence",
      verificationChecklist: [
        "Confirm the buy-side item is in stock at the listed Iowa store",
        "Confirm SKU/model/UPC and package quantity match",
        "Confirm the eBay sold comps are the exact same item",
        "Confirm sold condition is appropriate for the buy-side condition",
        "Confirm sold listings are not bundles or materially different accessories",
        "Confirm eBay fees, shipping and taxes before purchasing",
      ],
      isSoldComp: true,
    });
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
