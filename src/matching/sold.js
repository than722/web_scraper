const { normalize } = require("../config");
const { extractKeyTerms } = require("./text");

function extractQuantity(text) {
  const value = String(text || "").toLowerCase();

  // Explicit quantity indicators
  const patterns = [
    /\b(\d+)\s*(?:pack|pk)\b/i,
    /\bpack\s+of\s+(\d+)\b/i,
    /\b(\d+)\s*(?:piece|pieces|pc|pcs)\b/i,
    /\b(\d+)\s*(?:count|ct)\b/i,
    /\b(\d+)\s*x\s*(?:pack|pk)?\b/i,
    /\b(\d+)\s*-\s*pack\b/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);

    if (match) {
      const quantity = Number(match[1]);

      if (Number.isFinite(quantity) && quantity > 0) {
        return quantity;
      }
    }
  }

  // Common wording for bundles
  if (/\bdual\s+pack\b/i.test(value)) return 2;
  if (/\btwin\s+pack\b/i.test(value)) return 2;
  if (/\btwo\s+pack\b/i.test(value)) return 2;
  if (/\bdouble\s+pack\b/i.test(value)) return 2;
  if (/\btriple\s+pack\b/i.test(value)) return 3;
  if (/\bthree\s+pack\b/i.test(value)) return 3;

  // Default: assume one item
  return 1;
}
function extractModel(text) {
  const value = String(text || "").toUpperCase();

  // Sony model patterns, e.g.
  // XB100
  // SRS-XB100
  // SRSXB100
  // SRS-XB100/B
  const patterns = [
    /\bSRS[-\s]?XB\d+[A-Z0-9\/-]*/i,
    /\bXB\d+[A-Z0-9\/-]*/i,

    // General model-number patterns
    /\b[A-Z]{1,5}[-\s]?[A-Z]{0,3}\d{2,6}[A-Z0-9\/-]*\b/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);

    if (match) {
      return match[0]
        .replace(/\s+/g, "")
        .replace(/^-+|-+$/g, "")
        .toUpperCase();
    }
  }

  return null;
}
function textSimilarity(a, b) {
  const normalizeText = (text) =>
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const aTokens = new Set(
    normalizeText(a)
      .split(" ")
      .filter(Boolean)
  );

  const bTokens = new Set(
    normalizeText(b)
      .split(" ")
      .filter(Boolean)
  );

  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const token of aTokens) {
    if (bTokens.has(token)) {
      intersection++;
    }
  }

  const union = new Set([...aTokens, ...bTokens]).size;

  return union > 0 ? intersection / union : 0;
}

function matchProductToSoldComp(product, comp) {
  const productTitle = normalize(product.title || "");
  const compTitle = normalize(comp.title || "");

  const productBrand = extractBrand(product.title || "");
  const compBrand = extractBrand(comp.title || "");

  // --------------------------------------------------
  // Brand matching
  // --------------------------------------------------

  // Brand must match when both are known.
  if (
    productBrand &&
    compBrand &&
    productBrand !== compBrand
  ) {
    return {
      matches: false,
      reason: "brand_mismatch",
      score: 0,
    };
  }

  // --------------------------------------------------
  // Quantity matching
  // --------------------------------------------------

  const productQuantity = extractQuantity(product.title || "");
  const compQuantity = extractQuantity(comp.title || "");

  if (
    productQuantity !== null &&
    compQuantity !== null &&
    productQuantity !== compQuantity
  ) {
    return {
      matches: false,
      reason: "quantity_mismatch",
      score: 0,
    };
  }

  // Detect obvious multi-pack / bundle listings.
  const compIsMultiPack =
    /\b\d+\s*pack\b/i.test(comp.title || "") ||
    /\bdual\s*pack\b/i.test(comp.title || "") ||
    /\bbundle\b/i.test(comp.title || "");

  const productIsMultiPack =
    /\b\d+\s*pack\b/i.test(product.title || "") ||
    /\bdual\s*pack\b/i.test(product.title || "") ||
    /\bbundle\b/i.test(product.title || "");

  if (compIsMultiPack !== productIsMultiPack) {
    return {
      matches: false,
      reason: "quantity_mismatch",
      score: 0,
    };
  }

  // --------------------------------------------------
  // Bundle / accessory mismatch
  // --------------------------------------------------
  // Prevent a standalone charger from matching a charger+stand,
  // case, mount, bundle, kit, or similar materially different offer.
  const accessoryPatterns = [
    /\bwith\s+(?:stand|case|mount|cover|dock)\b/i,
    /\b(?:stand|case|mount|cover|dock)\s+included\b/i,
    /\b(?:bundle|combo|kit)\b/i,
    /\bcharger\s*\+\s*stand\b/i,
  ];

  const productAccessoryFlags = accessoryPatterns.map((re) => re.test(product.title || ""));
  const compAccessoryFlags = accessoryPatterns.map((re) => re.test(comp.title || ""));

  if (productAccessoryFlags.some(Boolean) !== compAccessoryFlags.some(Boolean)) {
    return {
      matches: false,
      reason: "accessory_bundle_mismatch",
      score: 0,
    };
  }

  // Specific accessory terms must also agree when they appear in only one title.
  for (const term of ["stand", "case", "mount", "dock", "cover"]) {
    const productHas = new RegExp(`\\b${term}\\b`, "i").test(product.title || "");
    const compHas = new RegExp(`\\b${term}\\b`, "i").test(comp.title || "");
    if (productHas !== compHas) {
      return {
        matches: false,
        reason: "accessory_bundle_mismatch",
        score: 0,
      };
    }
  }

  // --------------------------------------------------
  // Model matching
  // --------------------------------------------------

  const productModel = extractModel(product.title || "");
  const compModel = extractModel(comp.title || "");

  if (
    productModel &&
    compModel &&
    productModel !== compModel
  ) {
    return {
      matches: false,
      reason: "model_mismatch",
      score: 0,
    };
  }

  // --------------------------------------------------
  // Token similarity
  // --------------------------------------------------

  const similarity = textSimilarity(
    productTitle,
    compTitle
  );

  // --------------------------------------------------
  // Key-token overlap
  // --------------------------------------------------

  const productKeys = new Set(
    extractKeyTerms(productTitle)
  );

  const compKeys = extractKeyTerms(compTitle);

  let overlap = 0;

  if (productKeys.size > 0) {
    let matchedKeys = 0;

    for (const key of compKeys) {
      if (productKeys.has(key)) {
        matchedKeys++;
      }
    }

    overlap =
      matchedKeys /
      Math.max(
        productKeys.size,
        compKeys.length || 1
      );
  }

  // --------------------------------------------------
  // Matching thresholds
  // --------------------------------------------------

  if (similarity < 0.45) {
    return {
      matches: false,
      reason: "similarity_low",
      score: similarity,
      similarity,
      overlapRatio: overlap,
      modelMatch:
        Boolean(productModel && compModel) &&
        productModel === compModel,
    };
  }

  if (overlap < 0.5) {
    return {
      matches: false,
      reason: "key_overlap_low",
      score: similarity,
      similarity,
      overlapRatio: overlap,
      modelMatch:
        Boolean(productModel && compModel) &&
        productModel === compModel,
    };
  }

  // --------------------------------------------------
  // Successful match
  // --------------------------------------------------

  return {
    matches: true,
    reason: "matched",
    score: similarity,
    similarity,
    overlapRatio: overlap,
    modelMatch:
      Boolean(productModel && compModel) &&
      productModel === compModel,
  };
}

function extractBrand(title) {
  const text = String(title || "")
    .toLowerCase()
    .trim();

  const knownBrands = [
    "sony",
    "apple",
    "samsung",
    "bose",
    "jbl",
    "anker",
    "dewalt",
    "milwaukee",
    "makita",
    "ryobi",
    "black & decker",
    "craftsman",
    "lg",
    "hisense",
    "tcl",
    "philips",
    "lenovo",
    "hp",
    "dell",
    "asus",
    "acer",
    "logitech",
  ];

  for (const brand of knownBrands) {
    if (text.includes(brand)) {
      return brand;
    }
  }

  return null;
}
function extractModelIdentity(title) {
  let text = String(title || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  /*
   * Sony XB100 family.
   *
   * Normalize:
   * XB100
   * SRSXB100
   * SRSXB100B
   * SRSXB100D
   * SRSXB100H
   *
   * to:
   * XB100
   */
  const sonyXb100 = text.match(
    /(?:SRS)?XB100[A-Z]?/
  );

  if (sonyXb100) {
    return "XB100";
  }

  /*
   * Generic model patterns.
   */
  const patterns = [
    /\b([A-Z]{1,5}\d{2,5}[A-Z]?)\b/,
    /\b([A-Z]{2,8}-[A-Z0-9]{2,8})\b/,
  ];

  for (const pattern of patterns) {
    const match = String(title || "")
      .toUpperCase()
      .match(pattern);

    if (match?.[1]) {
      return match[1]
        .replace(/[^A-Z0-9]/g, "");
    }
  }

  return null;
}
function getIdentityTokens(title) {
  return normalize(title)
    .split(/\s+/)
    .map(token =>
      token
        .replace(/[^a-z0-9]/g, "")
        .trim()
    )
    .filter(token =>
      token.length >= 2 &&
      ![
        "the",
        "and",
        "for",
        "with",
        "new",
        "brand",
        "wireless",
        "bluetooth",
        "portable",
        "speaker",
        "black",
        "gray",
        "grey",
        "orange",
        "white",
      ].includes(token)
    );
}
function titleSimilarity(a, b) {
  const aTokens = new Set(
    String(a || "")
      .split(/\s+/)
      .filter(Boolean)
  );

  const bTokens = new Set(
    String(b || "")
      .split(/\s+/)
      .filter(Boolean)
  );

  if (!aTokens.size || !bTokens.size) {
    return 0;
  }

  let intersection = 0;

  for (const token of aTokens) {
    if (bTokens.has(token)) {
      intersection++;
    }
  }

  const union = new Set([
    ...aTokens,
    ...bTokens,
  ]).size;

  return union > 0
    ? intersection / union
    : 0;
}
function normalizeCondition(condition) {
  const value = String(condition || "")
    .toLowerCase()
    .trim();

  if (!value) return null;

  if (
    value.includes("brand new") ||
    value === "new"
  ) {
    return "new";
  }

  if (
    value.includes("open box") ||
    value.includes("open_box")
  ) {
    return "open_box";
  }

  if (
    value.includes("pre-owned") ||
    value.includes("preowned") ||
    value.includes("used")
  ) {
    return "used";
  }

  if (
    value.includes("refurbished") ||
    value.includes("renewed")
  ) {
    return "refurbished";
  }

  return value;
}


module.exports = { extractQuantity, extractModel, textSimilarity, matchProductToSoldComp, extractBrand, extractModelIdentity, getIdentityTokens, titleSimilarity, normalizeCondition };
