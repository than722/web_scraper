const { normalize, detectBrand } = require("../config");
const { extractModelNumber, extractKeyTerms, productText, productCategory, extractProductIdentifiers, classifySellability, netProfitEstimate, toConfidence } = require("./text");

function identityScore(buy, comp, similarity, overlapRatio, modelMatch, categoryMatch) {
  const buyText = productText(buy);
  const compText = productText(comp);
  const buyId = extractProductIdentifiers(
  buyText,
  buy.sku,
  buy.model
);

const compId = extractProductIdentifiers(
  compText,
  comp.sku,
  comp.model
);
  let score = 0;
  const signals = [];
  if (buyId.sku && compId.sku && String(buyId.sku).toLowerCase() === String(compId.sku).toLowerCase()) {
    score += 45; signals.push("exact_sku");
  }
  if (buyId.gtin && compId.gtin && buyId.gtin === compId.gtin) {
    score += 50; signals.push("exact_gtin");
  }
  if (modelMatch) { score += 35; signals.push("model_match"); }
  const buyBrand = detectBrand(buyText);
  const compBrand = detectBrand(compText);
  if (buyBrand && compBrand && buyBrand === compBrand) {
    score += 20; signals.push("brand_match");
  }
  if (categoryMatch) { score += 15; signals.push("category_match"); }
  if (similarity >= 0.45) { score += 15; signals.push("strong_title_similarity"); }
  else if (similarity >= 0.25) { score += 8; signals.push("title_similarity"); }
  if (overlapRatio >= 0.35) { score += 10; signals.push("key_overlap"); }
  else if (overlapRatio >= 0.15) { score += 5; signals.push("partial_key_overlap"); }
  return {
    score: Math.min(100, score),
    signals,
    buyModel: buyId.model, compModel: compId.model,
    buySku: buyId.sku, compSku: compId.sku,
    buyGtin: buyId.gtin, compGtin: compId.gtin,
  };
}

// ============================================================
// IMPROVED compareProducts - the core matching logic
// ============================================================
function compareProducts(buy, comp, minProfitPct, options = {}, diagnostics) {
  // ------------------------------------------------------------
  // SOURCE DETECTION
  // ------------------------------------------------------------

  const isSoldComp =
    comp?.source === "ebay_sold" ||
    comp?.listingType === "sold" ||
    comp?.comparisonType === "ebay_sold";

  const isDiscountRetailer =
    buy.source === "dollargeneral" ||
    comp.source === "dollargeneral" ||
    buy.source === "ollies" ||
    comp.source === "ollies" ||
    buy.source === "fivebelow" ||
    comp.source === "fivebelow" ||
    buy.source === "biglots" ||
    comp.source === "biglots";

  const isPurpleWave =
    buy.source === "purplewave" ||
    comp.source === "purplewave";

  // ------------------------------------------------------------
  // SAME RETAILER CHECK
  // ------------------------------------------------------------

  // Sold comps are NOT a retailer, so don't treat them as the
  // same retailer as the buy-side product.
  if (!isSoldComp && buy.storeName === comp.storeName) {
    diagnostics.sameRetailer++;
    return {
      status: "reject",
      reason: "same_retailer",
    };
  }

  // ------------------------------------------------------------
  // BUY LOCATION CHECK
  // ------------------------------------------------------------

  if (
    !buy.localStoreFound ||
    !buy.localStore?.withinCedarFallsRadius
  ) {
    diagnostics.buyOutsideRadius++;

    return {
      status: "reject",
      reason: "buy_outside_radius",
    };
  }

  // ------------------------------------------------------------
  // TEXT
  // ------------------------------------------------------------

  const buyText = productText(buy);
  const compText = productText(comp);

  // ------------------------------------------------------------
  // BRAND MATCHING
  // ------------------------------------------------------------

  const buyBrand = detectBrand(buyText);
  const compBrand = detectBrand(compText);

  let brandMatch = false;
  let brandMismatch = false;

  if (buyBrand && compBrand) {
    if (buyBrand === compBrand) {
      brandMatch = true;
    } else {
      const brandAliases = {
        dewalt: ["dewalt", "dewalt industrial"],
        milwaukee: ["milwaukee", "milwaukee tool"],
        makita: ["makita", "makita usa"],
        bosch: ["bosch", "bosch professional"],
        ryobi: ["ryobi", "ryobi one+"],
        craftsman: ["craftsman", "craftsman evolv"],
        "black decker": [
          "black decker",
          "black+decker",
          "black & decker",
        ],
        sony: ["sony"],
      };

      for (const [canonical, aliases] of Object.entries(brandAliases)) {
        const buyAliasMatch = aliases.some(
          (a) =>
            buyBrand.includes(a) ||
            a.includes(buyBrand)
        );

        const compAliasMatch = aliases.some(
          (a) =>
            compBrand.includes(a) ||
            a.includes(compBrand)
        );

        if (buyAliasMatch && compAliasMatch) {
          brandMatch = true;
          break;
        }
      }

      if (!brandMatch) {
        brandMismatch = true;

        // Sold comps should still require the same brand.
        // Don't loosen this simply because it came from eBay.
        if (!isDiscountRetailer && !isPurpleWave) {
          diagnostics.brandMismatch++;

          return {
            status: "reject",
            reason: "brand_mismatch",
          };
        }
      }
    }
  }

  // ------------------------------------------------------------
  // MODEL MATCHING
  // ------------------------------------------------------------

  const buyModel = extractModelNumber(buyText);
  const compModel = extractModelNumber(compText);

  let modelMatch = false;
  let modelMismatch = false;

  if (buyModel && compModel) {
    const normalizedBuy = buyModel
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

    const normalizedComp = compModel
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

    if (
      normalizedBuy === normalizedComp ||
      normalizedBuy.includes(normalizedComp) ||
      normalizedComp.includes(normalizedBuy)
    ) {
      modelMatch = true;
      diagnostics.modelMatches++;
    } else {
      const buyPrefix = normalizedBuy.substring(0, 4);
      const compPrefix = normalizedComp.substring(0, 4);

      if (
        buyPrefix === compPrefix &&
        buyPrefix.length >= 4
      ) {
        modelMatch = true;
        diagnostics.modelMatches++;
      } else {
        modelMismatch = true;

        // A sold comp with a different model should be rejected.
        if (isSoldComp) {
          diagnostics.modelMismatch++;

          return {
            status: "reject",
            reason: "sold_comp_model_mismatch",
            buyModel,
            compModel,
          };
        }

        if (!isDiscountRetailer && !isPurpleWave) {
          diagnostics.modelMismatch++;

          return {
            status: "reject",
            reason: "model_mismatch",
          };
        }
      }
    }
  }

  // ------------------------------------------------------------
  // CONDITION MATCHING FOR SOLD COMPS
  // ------------------------------------------------------------

  let conditionMatch = true;

  if (isSoldComp) {
    const buyCondition = String(
      buy.condition || "new"
    ).toLowerCase();

    const compCondition = String(
      comp.condition || ""
    ).toLowerCase();

    /*
     * We allow:
     *
     * new buy -> brand new sold
     * new buy -> open box sold
     *
     * because open-box/used sales are useful as a conservative
     * resale benchmark.
     *
     * But we don't allow completely unrelated conditions such
     * as parts/repair listings.
     */

    const badConditions = [
      "for parts",
      "parts only",
      "not working",
      "broken",
      "repair",
    ];

    if (
      badConditions.some((bad) =>
        compCondition.includes(bad)
      )
    ) {
      conditionMatch = false;

      return {
        status: "reject",
        reason: "sold_comp_bad_condition",
      };
    }

    // If the buy item is used/open-box, prefer comparable sold
    // conditions. We don't hard-reject new comps because those
    // are still useful market evidence.
    if (
      buyCondition.includes("open") &&
      compCondition.includes("pre-owned")
    ) {
      conditionMatch = true;
    }
  }

  // ------------------------------------------------------------
  // QUANTITY / BUNDLE CHECK
  // ------------------------------------------------------------

  /*
   * Prevent:
   *
   * Buy: Sony XB100 single
   * Sold: Sony XB100 2 Pack
   *
   * from being treated as a $47.99 single-item comp.
   */

  if (isSoldComp) {
    const buyHasTwoPack =
      /\b(2|two)\s*[- ]?pack\b/i.test(buyText) ||
      /\bpair\b/i.test(buyText);

    const compHasTwoPack =
      /\b(2|two)\s*[- ]?pack\b/i.test(compText) ||
      /\bpair\b/i.test(compText);

    const buyHasMultiQuantity =
      /\b(\d+)\s*(pack|pcs?|pieces|units?)\b/i.test(buyText);

    const compHasMultiQuantity =
      /\b(\d+)\s*(pack|pcs?|pieces|units?)\b/i.test(compText);

    if (
      !buyHasTwoPack &&
      !buyHasMultiQuantity &&
      (compHasTwoPack || compHasMultiQuantity)
    ) {
      return {
        status: "reject",
        reason: "sold_comp_quantity_mismatch",
      };
    }
  }

  // ------------------------------------------------------------
  // SIMILARITY
  // ------------------------------------------------------------

  let similarity = tokenSetSimilarity(
    buyText,
    compText
  );

  const buyCategory = productCategory(buyText);
  const compCategory = productCategory(compText);

  const categoryMatch = Boolean(
    buyCategory &&
    compCategory &&
    buyCategory === compCategory
  );

  // ------------------------------------------------------------
  // STRONG IDENTITY
  // ------------------------------------------------------------

  const strongIdentityMatch =
    brandMatch &&
    modelMatch;

  // ------------------------------------------------------------
  // SIMILARITY THRESHOLD
  // ------------------------------------------------------------

  let similarityThreshold = 0.60;

  if (isSoldComp) {
    /*
     * Sold comps frequently have messy eBay titles:
     *
     * Sony SRS-XB100 Wireless Bluetooth Portable Compact
     * Sony XB100 Genuine Extra Bass Portable Bluetooth Speaker
     *
     * Brand + model is much more important than title similarity.
     */
    similarityThreshold = 0.35;
  } else if (isDiscountRetailer) {
    similarityThreshold = categoryMatch
      ? 0.08
      : 0.15;
  } else if (isPurpleWave) {
    similarityThreshold = categoryMatch
      ? 0.05
      : 0.10;
  } else if (options.challengeMode) {
    similarityThreshold = 0.50;
  }

  if (
    similarity < similarityThreshold &&
    !isDiscountRetailer &&
    !isPurpleWave &&
    !strongIdentityMatch
  ) {
    diagnostics.similarityLow++;

    return {
      status: "reject",
      reason: "similarity_low",
      similarity,
      modelMatch,
      brandMatch,
    };
  }

  // ------------------------------------------------------------
  // KEY OVERLAP
  // ------------------------------------------------------------

  const buyKeys = new Set(
    extractKeyTerms(buyText)
  );

  const compKeys = extractKeyTerms(compText);

  let overlapRatio = 0;

  if (buyKeys.size > 0) {
    let keyOverlap = 0;

    for (const k of compKeys) {
      if (buyKeys.has(k)) {
        keyOverlap++;
      }
    }

    overlapRatio =
      keyOverlap /
      Math.max(
        buyKeys.size,
        compKeys.length || 1
      );

    let overlapThreshold;

    if (isSoldComp) {
      // Again, exact model identity is stronger than title overlap.
      overlapThreshold = 0.15;
    } else if (
      isDiscountRetailer ||
      isPurpleWave
    ) {
      overlapThreshold = 0.01;
    } else {
      overlapThreshold = options.challengeMode
        ? 0.15
        : 0.35;
    }

    if (
      overlapRatio < overlapThreshold &&
      !isDiscountRetailer &&
      !isPurpleWave &&
      !strongIdentityMatch
    ) {
      diagnostics.keyOverlapLow++;

      return {
        status: "reject",
        reason: "key_overlap_low",
        similarity,
        overlapRatio,
        modelMatch,
        brandMatch,
      };
    }
  }

  // ------------------------------------------------------------
  // PRICE
  // ------------------------------------------------------------

  const buyPrice = Number(buy.price);
  const compPrice = Number(comp.price);

  if (
    !Number.isFinite(buyPrice) ||
    !Number.isFinite(compPrice) ||
    buyPrice <= 0 ||
    compPrice <= 0
  ) {
    return {
      status: "reject",
      reason: "invalid_price",
    };
  }

  /*
   * For a sold comp:
   *
   * buyPrice = what we pay locally
   * compPrice = what someone actually paid on eBay
   *
   * Therefore compPrice MUST be higher.
   */

  if (compPrice <= buyPrice) {
    diagnostics.priceNotHigher++;

    return {
      status: "reject",
      reason: isSoldComp
        ? "sold_price_not_higher"
        : "price_not_higher",
      similarity,
      overlapRatio,
      modelMatch,
    };
  }

  const grossProfitPct =
    ((compPrice - buyPrice) / buyPrice) * 100;

  // ------------------------------------------------------------
  // PROFIT THRESHOLD
  // ------------------------------------------------------------

  if (grossProfitPct < minProfitPct) {
    diagnostics.belowThreshold++;

    /*
     * Keep reasonably close opportunities as near misses.
     */
    if (
      grossProfitPct >=
      minProfitPct - 20
    ) {
      return {
        status: "near",
        reason: isSoldComp
          ? "sold_comp_below_threshold"
          : "below_threshold",
        similarity,
        overlapRatio,
        grossProfitPct,
        modelMatch,
        brandMatch,
        conditionMatch,
      };
    }

    return {
      status: "reject",
      reason: isSoldComp
        ? "sold_comp_below_threshold"
        : "below_threshold",
      similarity,
      overlapRatio,
      grossProfitPct,
      modelMatch,
      brandMatch,
    };
  }

  // ------------------------------------------------------------
  // SELLABILITY
  // ------------------------------------------------------------

  const sellability =
    classifySellability(
      buyText,
      buyPrice
    );

  if (
    sellability.score < 0.40 &&
    !isDiscountRetailer &&
    !isPurpleWave
  ) {
    diagnostics.sellabilityLow++;

    return {
      status: "reject",
      reason: "sellability_low",
      similarity,
      overlapRatio,
      grossProfitPct,
      modelMatch,
    };
  }

  // ------------------------------------------------------------
  // CONFIDENCE
  // ------------------------------------------------------------

  const confidence = toConfidence(
    similarity,
    buy.rating,
    buy.reviewCount,
    modelMatch
  );

  const identity = identityScore(
    buy,
    comp,
    similarity,
    overlapRatio,
    modelMatch,
    categoryMatch
  );

  // ------------------------------------------------------------
  // NET PROFIT
  // ------------------------------------------------------------

  const net = netProfitEstimate(
    buyPrice,
    compPrice,
    options.sellFeePct,
    options.shippingCost
  );

  // ------------------------------------------------------------
  // SOLD COMP SPECIFIC CONFIDENCE
  // ------------------------------------------------------------

  let minConfidence = 0.35;
  let minIdentity = 35;

  let requiresMatch =
    modelMatch ||
    brandMatch ||
    similarity >= 0.20 ||
    categoryMatch;

  if (isSoldComp) {
    /*
     * Sold comps get special treatment:
     *
     * Exact model = strongest
     * Brand + model = very strong
     * Category + similarity = weaker
     */
    minConfidence = 0.25;
    minIdentity = 25;

    requiresMatch =
      modelMatch ||
      (brandMatch && categoryMatch) ||
      (brandMatch && similarity >= 0.30);
  }

  if (isDiscountRetailer) {
    minConfidence = 0.20;
    minIdentity = 20;

    requiresMatch =
      modelMatch ||
      brandMatch ||
      similarity >= 0.10 ||
      categoryMatch;
  }

  if (isPurpleWave) {
    minConfidence = 0.20;
    minIdentity = 15;

    requiresMatch =
      modelMatch ||
      brandMatch ||
      similarity >= 0.08 ||
      categoryMatch;
  }

  // ------------------------------------------------------------
  // QUALIFICATION
  // ------------------------------------------------------------

  const isQualified =
    grossProfitPct >= minProfitPct &&
    confidence >= minConfidence &&
    identity.score >= minIdentity &&
    requiresMatch;

  if (isQualified) {
    diagnostics.qualified++;

    return {
      status: "qualified",

      row: {
        title: buy.title,

        buyStore: buy.storeName,
        buyPrice,
        buyUrl: buy.url,
        buySku: buy.sku,
        buyLocalStore: buy.localStore,

        compStore: comp.storeName,
        compPrice,
        compUrl: comp.url,
        compSku: comp.sku,
        compSource: comp.source,

        compDescription:
          comp.description ||
          comp.rawDescription ||
          null,

        compCondition:
          comp.condition ||
          null,

        compSoldDate:
          comp.soldDate ||
          comp.endedAt ||
          null,

        comparisonType: isSoldComp
          ? "ebay_sold_comp"
          : comp.localStoreFound
            ? "local_retailer"
            : "public_online_price",

        estimatedProfitPct:
          Number(grossProfitPct.toFixed(2)),

        estimatedNetProfitPct:
          Number(net.netPct.toFixed(2)),

        estimatedNetProfit:
          Number(net.net.toFixed(2)),

        assumedSellFeePct:
          options.sellFeePct,

        assumedShippingCost:
          options.shippingCost,

        similarity:
          Number(similarity.toFixed(3)),

        keyOverlap:
          Number(overlapRatio.toFixed(3)),

        confidence,

        identityScore:
          identity.score,

        identitySignals:
          identity.signals,

        modelMatch,
        buyModel,
        compModel,

        brandMatch,
        buyBrand,
        compBrand,

        categoryMatch,
        buyCategory,
        compCategory,

        conditionMatch,

        sellabilityScore:
          sellability.score,

        sellabilityReason:
          sellability.reason,

        localAvailability:
          "manual_verification_required",

        verificationStatus:
          "candidate_requires_local_inventory_and_listing_validation",

        suspiciousSpread:
          grossProfitPct > 300,

        verificationChecklist: [
          "Confirm the buy-side item is in stock at the listed Iowa store",
          "Confirm SKU/model/UPC and package quantity match",
          "Confirm the eBay sold comp is the exact same item",
          "Confirm sold condition is appropriate for the buy-side condition",
          "Confirm sold price is not a bundle or multi-pack",
          "Confirm eBay fees, shipping and taxes before purchasing",
        ],

        isDiscountRetailer,
        discountMatch: false,

        isSoldComp,
      },
    };
  }

  // ------------------------------------------------------------
  // LEAD
  // ------------------------------------------------------------

  if (
    grossProfitPct >= minProfitPct &&
    identity.score >= 10
  ) {
    diagnostics.confidenceLow++;

    return {
      status: "lead",

      lead: {
        title: buy.title,

        buyStore: buy.storeName,
        buyPrice,
        buyUrl: buy.url,
        buySku: buy.sku,
        buyLocalStore: buy.localStore,

        compStore: comp.storeName,
        compPrice,
        compUrl: comp.url,
        compSku: comp.sku,
        compSource: comp.source,

        compCondition:
          comp.condition || null,

        compSoldDate:
          comp.soldDate ||
          comp.endedAt ||
          null,

        comparisonType: isSoldComp
          ? "ebay_sold_comp"
          : comp.localStoreFound
            ? "local_retailer"
            : "public_online_price",

        estimatedProfitPct:
          Number(grossProfitPct.toFixed(2)),

        estimatedNetProfitPct:
          Number(net.netPct.toFixed(2)),

        estimatedNetProfit:
          Number(net.net.toFixed(2)),

        confidence,

        identityScore:
          identity.score,

        identitySignals:
          identity.signals,

        similarity:
          Number(similarity.toFixed(3)),

        keyOverlap:
          Number(overlapRatio.toFixed(3)),

        modelMatch,
        buyModel,
        compModel,

        brandMatch,

        sellabilityScore:
          sellability.score,

        sellabilityReason:
          sellability.reason,

        suspiciousSpread:
          grossProfitPct > 300,

        status: "PROMISING_LEAD",

        verificationStatus:
          "manual_identity_and_local_inventory_required",

        verificationChecklist: [
          "Confirm the buy-side item is physically available at the Iowa store",
          "Confirm brand, model/part number, SKU/UPC and package quantity match",
          "Confirm the eBay sold listing is the exact same item",
          "Confirm sold condition is appropriate",
          "Confirm the sold listing is not a bundle or multi-pack",
          "Confirm sold-market demand before purchase",
          "Recalculate marketplace fees, shipping, taxes and pickup costs",
        ],

        reason: isSoldComp
          ? "Sold eBay comp indicates a potentially profitable resale spread; verify exact identity and condition"
          : isDiscountRetailer
            ? "Discount retailer item with profitable spread - verify exact product match"
            : isPurpleWave
              ? "Purple Wave item with profitable spread - verify exact product match"
              : "Profitable spread but automated identity confidence is below confirmed threshold",

        isSoldComp,
      },
    };
  }

  // ------------------------------------------------------------
  // REJECT
  // ------------------------------------------------------------

  return {
    status: "reject",
    reason: "confidence_low",
    similarity,
    overlapRatio,
    grossProfitPct,
    modelMatch,
    confidence,
  };
}
function calculateResaleProfit(buyPrice, resalePrice, options = {}) {
  const sellFeePct = Number(options.sellFeePct ?? 15);
  const shippingCost = Number(options.shippingCost ?? 0);

  const fee = resalePrice * (sellFeePct / 100);
  const netSale = resalePrice - fee - shippingCost;
  const profit = netSale - buyPrice;

  const profitPct =
    buyPrice > 0
      ? (profit / buyPrice) * 100
      : 0;

  return {
    buyPrice: Number(buyPrice.toFixed(2)),
    resalePrice: Number(resalePrice.toFixed(2)),
    sellFeePct,
    fee: Number(fee.toFixed(2)),
    shippingCost: Number(shippingCost.toFixed(2)),
    netSale: Number(netSale.toFixed(2)),
    profit: Number(profit.toFixed(2)),
    profitPct: Number(profitPct.toFixed(2)),
  };
}

const SOLD_COMPS_MAX_REQUESTS_TODAY = 45;

let soldCompsRequestsThisRun = 0;

const soldCompsCache = new Map();


module.exports = { identityScore, compareProducts, calculateResaleProfit };
