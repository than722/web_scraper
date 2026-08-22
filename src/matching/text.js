const { normalize, haversineMiles, CEDAR_FALLS, DEFAULT_RADIUS_MILES, CITY_CENTROIDS, SOURCE_TO_STORE_NAMES } = require("../config");

function extractModelNumber(title) {
    const text = String(title || "").toUpperCase();

    /*
     * ------------------------------------------------------------
     * BRAND-SPECIFIC MODEL NORMALIZATION
     * ------------------------------------------------------------
     *
     * Sony commonly appears in several formats:
     *
     *   XB100
     *   SRS-XB100
     *   SRSXB100
     *   SRSXB100/B
     *   SRSXB100/D
     *
     * Normalize all of these to:
     *
     *   XB100
     *
     * This is important because retailer titles are often formatted
     * differently even when they refer to the exact same product.
     */
    const sonyPatterns = [
        /\bSRS[-\s]?XB(\d{2,4})\b/,
        /\bXB(\d{2,4})\b/,
    ];

    for (const re of sonyPatterns) {
        const match = text.match(re);

        if (match) {
            return `XB${match[1]}`;
        }
    }

    /*
     * ------------------------------------------------------------
     * DEWALT
     * ------------------------------------------------------------
     *
     * Examples:
     *   DCD777
     *   DCF887
     *   DCD791D2
     */
    const dewalt = text.match(
        /\b(D[CF][A-Z]?\d{2,4}[A-Z0-9]*)\b/
    );

    if (dewalt) {
        return dewalt[1];
    }

    /*
     * ------------------------------------------------------------
     * MILWAUKEE
     * ------------------------------------------------------------
     *
     * Examples:
     *   2767-20
     *   2888-20
     *   2967-20
     */
    const milwaukee = text.match(
        /\b(\d{4}-?\d{2})\b/
    );

    if (milwaukee) {
        return milwaukee[1].replace(/-/g, "");
    }

    /*
     * ------------------------------------------------------------
     * MAKITA
     * ------------------------------------------------------------
     *
     * Examples:
     *   XFD07Z
     *   XDT14Z
     */
    const makita = text.match(
        /\b(X[A-Z]{2}\d{2}[A-Z]?)\b/
    );

    if (makita) {
        return makita[1];
    }

    /*
     * ------------------------------------------------------------
     * BOSCH
     * ------------------------------------------------------------
     *
     * Examples:
     *   GSR18V-140C
     */
    const bosch = text.match(
        /\b(GSR\d{2}V-[A-Z0-9]+)\b/
    );

    if (bosch) {
        return bosch[1].replace(/-/g, "");
    }

    /*
     * ------------------------------------------------------------
     * RYOBI
     * ------------------------------------------------------------
     *
     * Examples:
     *   P252
     *   P262
     */
    const ryobi = text.match(
        /\b(P\d{3}[A-Z]?)\b/
    );

    if (ryobi) {
        return ryobi[1];
    }

    /*
     * ------------------------------------------------------------
     * GENERAL MODEL PATTERNS
     * ------------------------------------------------------------
     */
    const patterns = [
        /*
         * General alphanumeric model:
         *
         *   DCD777
         *   XDT14Z
         *   P252
         *   AB1234
         */
        /\b([A-Z]{1,4}[- ]?\d{2,6}[A-Z0-9-]{0,8})\b/g,

        /*
         * Numeric models:
         *
         *   1234-56
         *   123456
         */
        /\b(\d{4}-?\d{2})\b/g,
    ];

    /*
     * Words/numbers that should NEVER be treated as models.
     */
    const blocked = new Set([
        "24V",
        "20V",
        "18V",
        "12V",
        "40V",
        "60V",
        "80V",
        "100V",
        "120V",
        "240V",

        "USB",
        "HDMI",
        "LED",
        "LCD",
        "WIFI",
        "BLUETOOTH",
        "WIRELESS",

        "MAX",
        "PRO",
        "PLUS",
        "MINI",

        "CORDLESS",
        "BRUSHLESS",
        "LITHIUM",
        "ION",
        "BATTERY",

        "IPX5",
        "IPX6",
        "IPX7",
        "IPX8",

        "SRS",
    ]);

    for (const re of patterns) {
        const matches = text.match(re) || [];

        for (const raw of matches) {
            const candidate = raw
                .replace(/\s+/g, "")
                .replace(/-/g, "");

            if (!candidate) continue;

            if (candidate.length < 3) continue;

            if (blocked.has(candidate)) continue;

            /*
             * Don't treat simple voltage numbers as models.
             */
            if (/^\d{2,3}V$/.test(candidate)) continue;

            /*
             * Don't treat short pure numbers as models.
             */
            if (/^\d+$/.test(candidate) && candidate.length < 4) {
                continue;
            }

            /*
             * Don't treat obvious product specifications
             * such as 30W, 24H, etc. as models.
             */
            if (/^\d{1,3}[WH]$/.test(candidate)) {
                continue;
            }

            return candidate;
        }
    }

    return null;
}

function extractKeyTerms(title) {
  const generic = new Set([
    "portable", "compact", "professional", "pro", "cordless", "battery", "kit",
    "included", "with", "and", "the", "for", "in", "on", "at", "to", "of", "a",
    "tool", "set", "charger", "case", "black", "white", "red", "blue", "green",
    "yellow", "orange", "silver", "pink", "gray", "grey", "new", "sale", "free",
    "ship", "plus", "max", "edition", "special", "limited", "wireless", "smart",
  ]);
  const normalized = normalize(title);
  return [...new Set(normalized.split(" ").filter(t => t.length > 2 && !generic.has(t)))];
}

function toConfidence(similarity, rating, reviewCount, modelMatch) {
  const simScore = Math.min(1, Math.max(0, similarity));
  const ratingScore = rating ? Math.min(1, Math.max(0, rating / 5)) : 0.4;
  const reviewScore = Math.min(1, Math.log10(Math.max(1, Number(reviewCount || 0) + 1)) / 3);
  const modelBonus = modelMatch ? 0.15 : 0;
  return Number((simScore * 0.55 + ratingScore * 0.2 + reviewScore * 0.1 + modelBonus).toFixed(3));
}

function localContextFromProduct(product) {
  const city = String(product?.localLocation?.city || product?.localCity || "").trim();
  const state = String(product?.localLocation?.state || product?.localState || "").trim();
  if (!city || !state) return null;
  const key = `${city.toLowerCase()},${state.toLowerCase()}`;
  const c = CITY_CENTROIDS[key];
  if (!c) return null;
  const dist = haversineMiles(CEDAR_FALLS.lat, CEDAR_FALLS.lon, c.lat, c.lon);
  return {
    name: product.storeName || product.source,
    address: product.localLocation?.address || "",
    city,
    state,
    zip: product.localLocation?.zip || "",
    distanceFromCedarFallsMiles: Number(dist.toFixed(2)),
    radiusMiles: DEFAULT_RADIUS_MILES,
    withinCedarFallsRadius: dist <= DEFAULT_RADIUS_MILES,
  };
}

function attachLocalStoreContext(products, inRadius) {
  const bySource = new Map();
  for (const [source, names] of Object.entries(SOURCE_TO_STORE_NAMES)) {
    const matches = inRadius.filter((s) => names.some((name) => String(s.name).toLowerCase() === name.toLowerCase()));
    if (matches.length) bySource.set(source, matches);
  }

  return products.map((p) => {
    let local = localContextFromProduct(p);
    if (!local) {
      const stores = bySource.get(p.source) || [];
      const candidate = stores[0] || null;
      if (candidate) {
        local = {
          name: candidate.name,
          address: candidate.address,
          city: candidate.city,
          state: candidate.state,
          zip: candidate.zip,
          distanceFromCedarFallsMiles: Number(candidate.distanceFromCedarFallsMiles),
          radiusMiles: DEFAULT_RADIUS_MILES,
          withinCedarFallsRadius: Boolean(candidate.withinCedarFallsRadius),
        };
      }
    }
    return {
      ...p,
      localSourceType: p.localSourceType || "national_or_online",
      localStoreFound: Boolean(local),
      localStore: local,
      localAvailability: "manual_verification_required",
    };
  });
}

function productText(product) {
  return [product?.title, product?.description, product?.rawDescription, product?.cardText]
    .filter(Boolean).join(" ");
}

function productCategory(text) {
  const n = normalize(text);
  const categories = [
    ["impact_driver", ["impact driver", "impact wrench"]],
    ["drill", ["cordless drill", "hammer drill", "core drill", "drill press", "drill"]],
    ["circular_saw", ["circular saw", "skill saw"]],
    ["sander", ["sander", "orbital sander", "belt sander"]],
    ["grinder", ["angle grinder", "grinder"]],
    ["tool_box", ["tool box", "toolbox", "chest", "tool cabinet"]],
    ["speaker", ["bluetooth speaker", "portable speaker", "speaker"]],
    ["headphones", ["headphones", "gaming headset", "headset"]],
    ["monitor", ["computer monitor", "monitor", "display"]],
    ["keyboard", ["keyboard"]],
    ["mouse", ["computer mouse", "wireless mouse", "mouse"]],
    ["tablet", ["tablet", "ipad"]],
    ["laptop", ["laptop", "notebook computer"]],
    ["coffee_maker", ["coffee maker", "coffee machine", "espresso machine"]],
    ["office_chair", ["office chair", "desk chair", "task chair"]],
    ["nightstand", ["nightstand", "bedside table"]],
    ["shelving", ["shelving", "shelf", "bookcase"]],
    ["dresser", ["dresser", "chest of drawers"]],
  ];
  for (const [cat, terms] of categories) {
    if (terms.some(t => n.includes(t))) return cat;
  }
  return null;
}

function extractProductIdentifiers(title, sku, explicitModel = null) {
  const text = String(title || "");

  const gtin = text.match(
    /\b(?:upc|gtin)\s*[:#-]?\s*(\d{12,14})\b/i
  );

  const model =
    explicitModel ||
    extractModelNumber(text);

  return {
    gtin: gtin ? gtin[1] : null,
    model: model || null,
    sku: sku || null,
  };
}

function classifySellability(title, price) {
  const n = normalize(title);
  const easy = [
    "drill", "impact driver", "circular saw", "jigsaw", "sander", "router",
    "grinder", "tool box", "tool set", "tool cabinet",
    "speaker", "headphones", "headset", "charger", "monitor",
    "keyboard", "mouse", "tablet", "laptop", "coffee maker",
    "lamp", "fan", "heater", "air purifier", "organizer", "storage",
    "office chair", "nightstand", "shelving", "dresser",
  ];
  const bulky = ["sofa", "sectional", "mattress", "refrigerator", "freezer", "dining table", "bed frame"];
  const matched = easy.some((k) => n.includes(k));
  const isBulky = bulky.some((k) => n.includes(k));
  let score = matched ? 0.75 : 0.45;
  if (isBulky) score -= 0.25;
  if (price <= 250) score += 0.10;
  if (price > 500) score -= 0.15;
  return {
    category: matched ? "easy_to_sell" : "general",
    score: Number(Math.max(0, Math.min(1, score)).toFixed(3)),
    reason: matched ? "Compact/high-demand category from challenge brief" : "No priority category match",
  };
}

function netProfitEstimate(buyPrice, compPrice, sellFeePct, shippingCost) {
  const fee = compPrice * (Math.max(0, sellFeePct) / 100);
  const net = compPrice - buyPrice - fee - Math.max(0, shippingCost);
  const netPct = buyPrice > 0 ? (net / buyPrice) * 100 : 0;
  return { fee, net, netPct };
}


module.exports = { extractModelNumber, extractKeyTerms, toConfidence, localContextFromProduct, attachLocalStoreContext, productText, productCategory, extractProductIdentifiers, classifySellability, netProfitEstimate };
