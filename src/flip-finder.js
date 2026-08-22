require("dotenv").config();

console.log(
  "SoldComps API key loaded:",
  Boolean(process.env.SOLDCOMPS_API_KEY)
);

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const CEDAR_FALLS = { lat: 42.5349, lon: -92.4453 };
const DEFAULT_RADIUS_MILES = 100;
const DEBUG_SCRAPE = process.env.FLIP_FINDER_DEBUG === "1";
const DEBUG_DIR = path.join(process.cwd(), "output", "debug");

const CITY_CENTROIDS = {
  "cedar falls,ia": { lat: 42.5349, lon: -92.4453 },
  "waterloo,ia": { lat: 42.4928, lon: -92.3426 },
  "cedar rapids,ia": { lat: 41.9779, lon: -91.6656 },
  "coralville,ia": { lat: 41.6764, lon: -91.5804 },
  "iowa city,ia": { lat: 41.6611, lon: -91.5302 },
  "williamsburg,ia": { lat: 41.6608, lon: -92.0074 },
  "polk city,ia": { lat: 41.7719, lon: -93.7124 },
  "ankeny,ia": { lat: 41.7318, lon: -93.6001 },
  "marshalltown,ia": { lat: 42.0492, lon: -92.9070 },
  "mason city,ia": { lat: 43.1536, lon: -93.2010 },
  "ames,ia": { lat: 42.0347, lon: -93.6200 },
  "reinbeck,ia": { lat: 42.3050, lon: -92.5990 },
  "jesup,ia": { lat: 42.4755, lon: -92.0646 },
  "new hampton,ia": { lat: 43.0591, lon: -92.3176 },
  "marengo,ia": { lat: 41.7981, lon: -92.0685 },
  "victor,ia": { lat: 41.7333, lon: -92.2896 },
  "swisher,ia": { lat: 41.8475, lon: -91.6913 },
};

// Maps scraper adapters to the local store records in data/stores.csv.
const SOURCE_TO_STORE_NAMES = {
  bestbuy: ["Best Buy"],
};

function parseArgs(argv) {
  const args = {
    query: "",
    bestBuyUrl: "",
    maxItemsPerStore: 25,
    minProfitPct: 50,
    topN: 5,
    jsonOut: "",
    headed: false,
    refresh: false,
    clearance: false,
    sellFeePct: 15,
    shippingCost: 0,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const v = argv[i];

    if (v === "--query" && argv[i + 1]) {
      args.query = argv[++i];

    } else if (
      v === "--best-buy-url" &&
      argv[i + 1]
    ) {
      args.bestBuyUrl = argv[++i];

    } else if (
      v === "--max-items-per-store" &&
      argv[i + 1]
    ) {
      args.maxItemsPerStore = Number(argv[++i]);

    } else if (
      v === "--min-profit-pct" &&
      argv[i + 1]
    ) {
      args.minProfitPct = Number(argv[++i]);

    } else if (
      v === "--top-n" &&
      argv[i + 1]
    ) {
      args.topN = Number(argv[++i]);

    } else if (
      v === "--json-out" &&
      argv[i + 1]
    ) {
      args.jsonOut = argv[++i];

    } else if (v === "--headed") {
      args.headed = true;

    } else if (v === "--refresh") {
      args.refresh = true;

    } else if (v === "--clearance") {
      args.clearance = true;

    } else if (
      v === "--sell-fee-pct" &&
      argv[i + 1]
    ) {
      args.sellFeePct = Number(argv[++i]);

    } else if (
      v === "--shipping-cost" &&
      argv[i + 1]
    ) {
      args.shippingCost = Number(argv[++i]);
    }
  }

  return args;
}

function resolveBudgetProfile(args) {
  return {
    mode: "normal",
    maxItemsPerStore: args.maxItemsPerStore,
    useCache: true,
    cacheTtlMinutes: 90,
    enableBestBuy: true,
  };
}

function getCachePath(query) {
  const safe = normalize(query).replace(/\s+/g, "-") || "query";
  return path.join(process.cwd(), "output", "cache", `${safe}.json`);
}

function readCache(cachePath, ttlMinutes) {
  if (!fs.existsSync(cachePath)) return null;
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    const generatedAt = new Date(parsed.generatedAt || 0).getTime();
    if (!generatedAt) return null;
    const ageMinutes = (Date.now() - generatedAt) / 60000;
    if (ageMinutes > ttlMinutes) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(cachePath, report) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(report, null, 2), "utf8");
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSetSimilarity(a, b) {
  const sa = new Set(normalize(a).split(" ").filter(Boolean));
  const sb = new Set(normalize(b).split(" ").filter(Boolean));
  if (!sa.size || !sb.size) return 0;

  let inter = 0;
  for (const tok of sa) if (sb.has(tok)) inter += 1;

  // If no exact matches, try partial matches
  if (inter === 0) {
    let partialMatches = 0;
    const saArr = Array.from(sa);
    const sbArr = Array.from(sb);
    for (const aTok of saArr) {
      for (const bTok of sbArr) {
        if (aTok.length > 3 && bTok.length > 3) {
          if (aTok.includes(bTok) || bTok.includes(aTok)) {
            partialMatches += 0.5;
            break;
          }
        }
      }
    }
    return Math.min(1, (2 * partialMatches) / (sa.size + sb.size));
  }

  return (2 * inter) / (sa.size + sb.size);
}

function detectBrand(title) {
  const brands = [
    "greenworks",
    "dewalt",
    "milwaukee",
    "makita",
    "bosch",
    "worx",
    "vevor",
    "ryobi",
    "craftsman",
    "black decker",
  ];
  const n = normalize(title);
  for (const brand of brands) {
    if (n.includes(brand)) return brand;
  }
  return "";
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const lines = raw.split(/\r?\n/);
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (cols[idx] || "").trim();
    });
    return row;
  });
}

function storesWithinRadius(rows, radiusMiles) {
  return rows
    .map((r) => {
      const key = `${String(r.city).toLowerCase()},${String(r.state).toLowerCase()}`;
      const c = CITY_CENTROIDS[key];
      if (!c) return null;
      const dist = haversineMiles(CEDAR_FALLS.lat, CEDAR_FALLS.lon, c.lat, c.lon);
      return {
        ...r,
        distanceFromCedarFallsMiles: Number(dist.toFixed(2)),
        withinCedarFallsRadius: dist <= radiusMiles,
      };
    })
    .filter((r) => r && r.withinCedarFallsRadius);
}

async function robotsAllowed(url, label = "") {
  const tag = label ? `[${label}] ` : "";
  try {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    const res = await fetch(robotsUrl, { redirect: "follow" });
    if (!res.ok) {
      console.warn(`  ${tag}robots.txt fetch failed (HTTP ${res.status}) — treating as disallowed`);
      return false;
    }
    const txt = await res.text();

    let inDefault = false;
    const disallow = [];
    for (const rawLine of txt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const [k, ...rest] = line.split(":");
      const key = k.trim().toLowerCase();
      const value = rest.join(":").trim();

      if (key === "user-agent") {
        inDefault = value === "*";
      } else if (inDefault && key === "disallow") {
        disallow.push(value);
      }
    }

    for (const rule of disallow) {
      if (!rule) continue;
      if (u.pathname.startsWith(rule)) {
        console.warn(`  ${tag}blocked by robots.txt rule "Disallow: ${rule}" for path ${u.pathname}`);
        return false;
      }
    }

    return true;
  } catch (err) {
    console.warn(`  ${tag}robots.txt check threw (${String(err?.message || err).slice(0, 200)}) — treating as disallowed`);
    return false;
  }
}

async function debugSnapshot(label, query, page) {
  if (!DEBUG_SCRAPE || !page) return;
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const safe = `${normalize(label)}-${normalize(query)}`.replace(/\s+/g, "-");
    const html = await page.content();
    fs.writeFileSync(path.join(DEBUG_DIR, `${safe}.html`), html, "utf8");
    await page.screenshot({ path: path.join(DEBUG_DIR, `${safe}.png`), fullPage: false }).catch(() => {});
    console.warn(`  [${label}] saved debug snapshot: output/debug/${safe}.html (+ .png)`);
  } catch (err) {
    console.warn(`  [${label}] failed to save debug snapshot: ${String(err?.message || err).slice(0, 200)}`);
  }
}

function cleanPrice(value) {
  if (typeof value === "number") return value;
  const m = String(value || "").match(/([0-9]+(?:\.[0-9]{1,2})?)/);
  return m ? Number(m[1]) : NaN;
}


async function scrapeBestBuy(
  browser,
  query,
  maxItems,
  clearance = false,
  bestBuyUrl = ""
) {
  const encodedQuery = encodeURIComponent(query || "");

  const isSpecificProduct =
    Boolean(bestBuyUrl && bestBuyUrl.trim());

  const clearanceUrl =
    "https://www.bestbuy.com/site/searchpage.jsp" +
    "?browsedCategory=pcmcat748300666044" +
    "&id=pcat17071" +
    "&qp=currentoffers_facet%3DCurrent+Deals~Clearance" +
    "&st=pcmcat748300666044_categoryid%24cat00000";

  const normalUrl =
    `https://www.bestbuy.com/site/searchpage.jsp?st=${encodedQuery}&intl=nosplash`;

  const context = await browser.newContext({
    viewport: {
      width: 1440,
      height: 900,
    },

    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/151.0.0.0 Safari/537.36",

    locale: "en-US",

    timezoneId: "America/Chicago",

    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const page = await context.newPage();

  try {
    /*
     * =========================================================
     * SPECIFIC BEST BUY PRODUCT MODE
     * =========================================================
     */

    if (isSpecificProduct) {
  if (
    !(await robotsAllowed(
      bestBuyUrl,
      "bestbuy"
    ))
  ) {
    console.warn(
      "  [bestbuy] specific product URL is disallowed by robots.txt"
    );

    return [];
  }

  console.log(
    `  [bestbuy] SPECIFIC PRODUCT URL: ${bestBuyUrl}`
  );

  /*
   * ---------------------------------------------------------
   * TRY MULTIPLE NAVIGATION STRATEGIES
   * ---------------------------------------------------------
   *
   * Best Buy can terminate HTTP/2 connections on some
   * product/open-box URLs. Try the original URL first,
   * then a cleaned URL, then the normal product URL.
   */

  const navigationUrls = [];

  /*
   * 1. Original URL exactly as supplied.
   */
  navigationUrls.push(bestBuyUrl);

  /*
   * 2. Remove the open-box query string but keep /openbox.
   *
   * Example:
   *
   * /6610891/openbox?condition=fair
   *
   * becomes:
   *
   * /6610891/openbox
   */
  try {
    const parsed =
      new URL(bestBuyUrl);

    parsed.search = "";

    navigationUrls.push(
      parsed.toString()
    );
  } catch {
    // Ignore invalid URL here.
  }

  /*
   * 3. Normal product URL.
   *
   * Example:
   *
   * /6610891/openbox?condition=fair
   *
   * becomes:
   *
   * /6610891
   */
  try {
    const parsed =
      new URL(bestBuyUrl);

    const match =
      parsed.pathname.match(
        /^(.*\/\d+)(?:\/openbox)?$/i
      );

    if (match) {
      parsed.pathname =
        match[1];

      parsed.search = "";

      navigationUrls.push(
        parsed.toString()
      );
    }
  } catch {
    // Ignore URL parsing failure.
  }

  /*
   * Remove duplicate URLs.
   */
  const uniqueNavigationUrls =
    [
      ...new Set(
        navigationUrls
      ),
    ];

  let loaded = false;
  let successfulUrl = "";

  for (
    const navigationUrl of
      uniqueNavigationUrls
  ) {
    console.log(
      `  [bestbuy] trying product URL: ${navigationUrl}`
    );

    try {
      await page.goto(
        navigationUrl,
        {
          waitUntil:
            "domcontentloaded",
          timeout: 45000,
        }
      );

      await page.waitForTimeout(
        5000
      );

      console.log(
        `  [bestbuy] loaded title: ${await page.title()}`
      );

      console.log(
        `  [bestbuy] loaded url: ${page.url()}`
      );

      loaded = true;
      successfulUrl =
        page.url();

      break;

    } catch (error) {
      console.warn(
        `  [bestbuy] navigation failed: ${
          error?.message || error
        }`
      );

      /*
       * Clear the page before trying the
       * next navigation strategy.
       */
      try {
        await page.goto(
          "about:blank",
          {
            waitUntil:
              "commit",
            timeout: 10000,
          }
        );
      } catch {
        // Ignore cleanup failure.
      }
    }
  }

  if (!loaded) {
    console.warn(
      "  [bestbuy] all product-page navigation attempts failed."
    );

    return [];
  }

  /*
   * ---------------------------------------------------------
   * COUNTRY REDIRECT
   * ---------------------------------------------------------
   */

  const currentUrl =
    page.url().toLowerCase();

  const pageTitle =
    (
      await page.title()
    ).toLowerCase();

  if (
    currentUrl.includes(
      "international"
    ) ||
    pageTitle.includes(
      "select your country"
    )
  ) {
    console.warn(
      "  [bestbuy] product page redirected to Best Buy's international country-selection page."
    );

    return [];
  }

  /*
   * ---------------------------------------------------------
   * BASIC PAGE DIAGNOSTICS
   * ---------------------------------------------------------
   */

  const bodyText =
    await page
      .locator("body")
      .innerText()
      .catch(() => "");

  console.log(
    `  [bestbuy] successful product URL: ${successfulUrl}`
  );

  console.log(
    `  [bestbuy] page text length: ${bodyText.length}`
  );

  console.log(
    `  [bestbuy] product page contains Lenovo: ${
      bodyText
        .toLowerCase()
        .includes("lenovo")
    }`
  );

  /*
   * ---------------------------------------------------------
   * EXTRACT PRODUCT
   * ---------------------------------------------------------
   */

  const product =
    await page.evaluate(() => {
      const bodyText =
        document.body?.innerText ||
        "";

      const normalizedText =
        bodyText
          .replace(/\s+/g, " ")
          .trim();

      /*
       * TITLE
       */

      const titleCandidates = [
        document.querySelector(
          "h1"
        )?.textContent,

        document.querySelector(
          '[data-testid="product-title"]'
        )?.textContent,

        document.querySelector(
          '[class*="product-title"]'
        )?.textContent,

        document.title,
      ];

      let title =
        titleCandidates
          .map((value) =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim()
          )
          .find(
            (value) =>
              value &&
              value.length >= 10
          ) || "";

      title = title
        .replace(
          /\s*\|\s*Best Buy.*$/i,
          ""
        )
        .trim();

      /*
       * SKU
       */

      let sku = "";

      const skuPatterns = [
        /sku[:\s#]*([0-9]{5,})/i,

        /model number[:\s#]*([A-Z0-9-]{3,})/i,
      ];

      for (
        const pattern of
          skuPatterns
      ) {
        const match =
          normalizedText.match(
            pattern
          );

        if (match) {
          sku = match[1];
          break;
        }
      }

      /*
       * Also extract SKU from URL.
       */

      const urlMatch =
        window.location.href.match(
          /\/(\d{5,})(?:\/openbox)?(?:\?|$)/i
        );

      if (
        urlMatch &&
        /^\d+$/.test(
          urlMatch[1]
        )
      ) {
        sku =
          urlMatch[1];
      }

      /*
       * PRICE
       */

      const priceMatches = [
        ...normalizedText.matchAll(
          /\$\s*([0-9]+(?:\.[0-9]{1,2})?)/g
        ),
      ]
        .map(
          (match) =>
            Number(match[1])
        )
        .filter(
          (value) =>
            Number.isFinite(
              value
            ) &&
            value > 1
        );

      /*
       * Avoid taking an absurdly high number
       * if the page contains unrelated prices.
       */
      const price =
        priceMatches.length
          ? priceMatches[0]
          : null;

      /*
       * CONDITION
       */

      const lowerText =
        normalizedText.toLowerCase();

      const isOpenBox =
        lowerText.includes(
          "open-box"
        ) ||
        lowerText.includes(
          "open box"
        );

      const isClearance =
        lowerText.includes(
          "clearance"
        );

      const isSale =
        lowerText.includes(
          "sale"
        ) ||
        lowerText.includes(
          "deal"
        ) ||
        lowerText.includes(
          "discount"
        ) ||
        lowerText.includes(
          "save $"
        );

      /*
       * OPEN-BOX CONDITION
       */

      let condition =
        null;

      const conditionPatterns = [
        /condition[:\s]+(excellent|good|fair|satisfactory|acceptable)/i,

        /(excellent|good|fair|satisfactory|acceptable)\s+condition/i,

        /open[-\s]?box[^.]{0,120}(excellent|good|fair|satisfactory|acceptable)/i,
      ];

      for (
        const pattern of
          conditionPatterns
      ) {
        const match =
          normalizedText.match(
            pattern
          );

        if (match) {
          condition =
            match[1].toLowerCase();

          break;
        }
      }

      /*
       * RATING
       */

      let rating = null;

      const ratingMatch =
        normalizedText.match(
          /([0-5](?:\.[0-9]+)?)\s*(?:out of 5|stars)/i
        );

      if (ratingMatch) {
        rating =
          Number(
            ratingMatch[1]
          );
      }

      /*
       * REVIEW COUNT
       */

      let reviewCount = 0;

      const reviewPatterns = [
        /([0-9][0-9,]*)\s+reviews?/i,

        /([0-9][0-9,]*)\s+ratings?/i,
      ];

      for (
        const pattern of
          reviewPatterns
      ) {
        const match =
          normalizedText.match(
            pattern
          );

        if (match) {
          reviewCount =
            Number(
              match[1].replace(
                /,/g,
                ""
              )
            );

          break;
        }
      }

      /*
       * MODEL NUMBER
       */

      let model = null;

      const modelPatterns = [
        /model number[:\s#]*([A-Z0-9][A-Z0-9-]{2,})/i,

        /mfr part number[:\s#]*([A-Z0-9][A-Z0-9-]{2,})/i,

        /manufacturer part number[:\s#]*([A-Z0-9][A-Z0-9-]{2,})/i,
      ];

      for (
        const pattern of
          modelPatterns
      ) {
        const match =
          normalizedText.match(
            pattern
          );

        if (match) {
          model =
            match[1];

          break;
        }
      }

      /*
       * COMPARABLE / ORIGINAL VALUE
       */

      let comparableValue =
        null;

      const comparablePatterns = [
        /comparable value[:\s]*\$([0-9]+(?:\.[0-9]{1,2})?)/i,

        /original price[:\s]*\$([0-9]+(?:\.[0-9]{1,2})?)/i,

        /was[:\s]*\$([0-9]+(?:\.[0-9]{1,2})?)/i,

        /regular price[:\s]*\$([0-9]+(?:\.[0-9]{1,2})?)/i,
      ];

      for (
        const pattern of
          comparablePatterns
      ) {
        const match =
          normalizedText.match(
            pattern
          );

        if (match) {
          comparableValue =
            Number(
              match[1]
            );

          break;
        }
      }

      /*
       * SAVINGS
       */

      let savings = null;

      const savingsMatch =
        normalizedText.match(
          /save\s+\$([0-9]+(?:\.[0-9]{1,2})?)/i
        );

      if (savingsMatch) {
        savings =
          Number(
            savingsMatch[1]
          );
      }

      return {
        source:
          "bestbuy",

        storeName:
          "Best Buy",

        title,

        price,

        sku,

        model,

        url:
          window.location.href,

        rating,

        reviewCount,

        rawDescription:
          normalizedText,

        clearance:
          isClearance,

        isClearance,

        isOpenBox,

        isSale,

        condition,

        comparableValue,

        savings,
      };
    });

  /*
   * ---------------------------------------------------------
   * VALIDATE
   * ---------------------------------------------------------
   */

  if (
    !product ||
    !product.title ||
    !product.price
  ) {
    console.warn(
      "  [bestbuy] page loaded, but product data could not be extracted."
    );

    console.warn(
      `  [bestbuy] extracted title: ${
        product?.title || "N/A"
      }`
    );

    console.warn(
      `  [bestbuy] extracted price: ${
        product?.price || "N/A"
      }`
    );

    /*
     * Save a debug snapshot if your project
     * already has debugSnapshot().
     */
    try {
      await debugSnapshot(
        "bestbuy-specific",
        "specific-product",
        page
      );
    } catch {
      // Debug snapshot is optional.
    }

    return [];
  }

  /*
   * ---------------------------------------------------------
   * FORCE DATA FROM THE SUPPLIED URL
   * ---------------------------------------------------------
   */

  if (!product.sku) {
    const skuMatch =
      bestBuyUrl.match(
        /\/(\d{5,})(?:\/openbox)?(?:\?|$)/i
      );

    if (skuMatch) {
      product.sku =
        skuMatch[1];
    }
  }

  /*
   * The supplied URL explicitly contains /openbox.
   */

  if (
    bestBuyUrl
      .toLowerCase()
      .includes("/openbox")
  ) {
    product.isOpenBox = true;
  }

  /*
   * condition=fair is also explicitly present.
   */

  try {
    const parsed =
      new URL(bestBuyUrl);

    const conditionParam =
      parsed.searchParams.get(
        "condition"
      );

    if (conditionParam) {
      product.condition =
        conditionParam.toLowerCase();
    }
  } catch {
    // Ignore URL parsing failure.
  }

  product.searchQuery =
    query || null;

  product.specificProduct =
    true;

  console.log(
    "  [bestbuy] SPECIFIC PRODUCT FOUND"
  );

  console.log(
    `  [bestbuy] title: ${product.title}`
  );

  console.log(
    `  [bestbuy] price: $${product.price}`
  );

  console.log(
    `  [bestbuy] SKU: ${
      product.sku || "N/A"
    }`
  );

  console.log(
    `  [bestbuy] model: ${
      product.model || "N/A"
    }`
  );

  console.log(
    `  [bestbuy] condition: ${
      product.condition || "N/A"
    }`
  );

  console.log(
    `  [bestbuy] open-box: ${
      product.isOpenBox
    }`
  );

  console.log(
    `  [bestbuy] comparable value: ${
      product.comparableValue
        ? "$" +
          product.comparableValue
        : "N/A"
    }`
  );

  return [product];
}

    /*
     * =========================================================
     * NORMAL SEARCH MODE
     * =========================================================
     */

    if (!clearance) {
      if (
        !(await robotsAllowed(
          normalUrl,
          "bestbuy"
        ))
      ) {
        console.warn(
          "  [bestbuy] robots.txt disallowed this URL"
        );

        return [];
      }

      await page.goto(
        normalUrl,
        {
          waitUntil:
            "domcontentloaded",
          timeout: 45000,
        }
      );

      await page.waitForTimeout(
        5000
      );

      console.log(
        `  [bestbuy] page loaded: ${await page.title()}`
      );

      console.log(
        `  [bestbuy] url: ${page.url()}`
      );

      if (
        page.url()
          .toLowerCase()
          .includes("international") ||
        (await page.title())
          .toLowerCase()
          .includes("select your country")
      ) {
        console.warn(
          "  [bestbuy] US inventory redirected to international country-selection page."
        );

        return [];
      }

      const rows =
        await page.evaluate(() => {
          const anchors =
            Array.from(
              document.querySelectorAll(
                'a[href*="/site/"]'
              )
            );

          const out = [];

          for (
            const a of anchors
          ) {
            const href =
              a.href || "";

            const title =
              (
                a.textContent ||
                ""
              )
                .replace(
                  /\s+/g,
                  " "
                )
                .trim();

            if (
              !title ||
              title.length < 10
            ) {
              continue;
            }

            if (
              !/\/site\/.+\/\d+\.p(?:\?|$)/i.test(
                href
              )
            ) {
              continue;
            }

            const parent =
              a.closest(
                "li, article, div"
              );

            const block =
              (
                parent?.textContent ||
                a.parentElement
                  ?.textContent ||
                ""
              )
                .replace(
                  /\s+/g,
                  " "
                )
                .trim();

            const priceMatch =
              block.match(
                /\$\s*([0-9]+(?:\.[0-9]{1,2})?)/
              );

            if (!priceMatch) {
              continue;
            }

            const price =
              Number(
                priceMatch[1]
              );

            if (
              !Number.isFinite(
                price
              ) ||
              price <= 1
            ) {
              continue;
            }

            const skuMatch =
              href.match(
                /\/(\d+)\.p(?:\?|$)/i
              );

            out.push({
              source:
                "bestbuy",

              storeName:
                "Best Buy",

              title,

              price,

              sku:
                skuMatch
                  ? skuMatch[1]
                  : "",

              model: null,

              url: href,

              rating: null,

              reviewCount: 0,

              rawDescription:
                block,

              clearance: false,

              isClearance:
                block
                  .toLowerCase()
                  .includes(
                    "clearance"
                  ),

              isOpenBox:
                block
                  .toLowerCase()
                  .includes(
                    "open box"
                  ) ||
                block
                  .toLowerCase()
                  .includes(
                    "open-box"
                  ),

              isSale:
                block
                  .toLowerCase()
                  .includes(
                    "sale"
                  ) ||
                block
                  .toLowerCase()
                  .includes(
                    "deal"
                  ),

              comparableValue:
                null,

              savings:
                null,
            });
          }

          return out;
        });

      const dedup =
        new Map();

      for (
        const row of rows
      ) {
        const key =
          row.sku
            ? `sku:${row.sku}`
            : `title:${row.title.toLowerCase()}`;

        if (!dedup.has(key)) {
          dedup.set(
            key,
            row
          );
        }

        if (
          dedup.size >=
          maxItems
        ) {
          break;
        }
      }

      const products =
        Array.from(
          dedup.values()
        ).slice(
          0,
          maxItems
        );

      console.log(
        `  [bestbuy] extracted ${products.length} unique products from ${rows.length} raw results`
      );

      return products;
    }

    /*
     * =========================================================
     * CLEARANCE MODE
     * =========================================================
     *
     * Keep your existing clearance implementation here.
     *
     * IMPORTANT:
     * The specific-product mode above runs BEFORE clearance
     * mode, so --best-buy-url works independently.
     */

    console.warn(
      "  [bestbuy] Clearance mode requested."
    );

    console.warn(
      "  [bestbuy] Use the existing clearance scraping block here."
    );

    return [];

  } finally {
    await context.close();
  }
}

async function scrapeWalmart(browser, query, maxItems) {
  const searchUrl = `https://www.walmart.com/search?q=${encodeURIComponent(query)}`;

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/151.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    const response = await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForTimeout(3000);

    if (!response || response.status() >= 400) {
      throw new Error(
        `Walmart returned HTTP ${response?.status() ?? "unknown"}`
      );
    }

    console.log(`  [walmart] page loaded: ${await page.title()}`);
    console.log(`  [walmart] url: ${page.url()}`);

    /*
     * Find Walmart product links from the search page.
     *
     * We intentionally do NOT visit individual /ip/ pages.
     * Walmart may return a "Robot or human?" challenge there.
     */
    const rawProducts = await page.evaluate(() => {
      const links = Array.from(
        document.querySelectorAll('a[href*="/ip/"], a[href*="/sp/track"]')
      );

      return links
        .map((a) => {
          const text = (a.textContent || "")
            .replace(/\s+/g, " ")
            .trim();

          let href = a.href || "";

          try {
            const url = new URL(href);

            /*
             * Walmart search results can use /sp/track URLs.
             * Extract the real /ip/ product URL from rd= when present.
             */
            if (url.pathname === "/sp/track") {
              const redirect = url.searchParams.get("rd");

              if (redirect) {
                href = redirect;
              }
            }
          } catch {
            // Ignore malformed URLs.
          }

          if (!href.includes("/ip/")) {
            return null;
          }

          return {
            title: text,
            url: href,
          };
        })
        .filter(Boolean);
    });

    /*
     * Deduplicate product URLs.
     */
    const seen = new Set();
    const products = [];

    for (const product of rawProducts) {
      if (!product?.url || seen.has(product.url)) {
        continue;
      }

      seen.add(product.url);

      if (!product.title || product.title.length < 10) {
        continue;
      }

      products.push({
        title: product.title,
        url: product.url,
      });

      if (products.length >= maxItems) {
        break;
      }
    }

    console.log(
      `  [walmart] found ${products.length} candidate product links`
    );

    /*
     * Extract title + price directly from the Walmart search page.
     *
     * We do NOT open the individual product pages because those
     * pages can trigger Walmart's "Robot or human?" challenge.
     */
    const results = await page.evaluate((maxItems) => {
      const normalizeText = (value) =>
        (value || "").replace(/\s+/g, " ").trim();

      const links = Array.from(
        document.querySelectorAll(
          'a[href*="/ip/"], a[href*="/sp/track"]'
        )
      );

      const seen = new Set();
      const extracted = [];

      for (const link of links) {
        if (extracted.length >= maxItems) {
          break;
        }

        let href = link.href || "";

        /*
         * Resolve Walmart tracking URLs.
         */
        try {
          const url = new URL(href);

          if (url.pathname === "/sp/track") {
            const redirect = url.searchParams.get("rd");

            if (redirect) {
              href = redirect;
            }
          }
        } catch {
          continue;
        }

        if (!href.includes("/ip/")) {
          continue;
        }

        /*
         * Extract Walmart product ID.
         *
         * Example:
         * /ip/Product-Name/19690353571
         */
        let sku = null;

        const idMatch = href.match(/\/(\d+)(?:[?&]|$)/);

        if (idMatch) {
          sku = idMatch[1];
        }

        const dedupeKey = sku || href;

        if (seen.has(dedupeKey)) {
          continue;
        }

        seen.add(dedupeKey);

        /*
         * Start at the product link and walk upward looking
         * for a container that contains both the product title
         * and a price.
         */
        let card = link;

        for (let level = 0; level < 8; level++) {
          const parent = card.parentElement;

          if (!parent) {
            break;
          }

          const text = normalizeText(parent.innerText);

          const hasPrice =
            /\$\s*\d[\d,]*(?:\.\d{1,2})?/.test(text);

          if (
            hasPrice &&
            text.length >= 20 &&
            text.length <= 3000
          ) {
            card = parent;
            break;
          }

          card = parent;
        }

        const cardText = normalizeText(card.innerText);

        /*
         * Get the title from the product link first.
         */
        let title = normalizeText(link.innerText);

        /*
         * Some Walmart links have very little text.
         * Try aria-label/title attributes before falling back
         * to the card text.
         */
        if (!title || title.length < 10) {
          title =
            normalizeText(link.getAttribute("aria-label")) ||
            normalizeText(link.getAttribute("title"));
        }

        if (!title || title.length < 10) {
          title = cardText;
        }

        /*
         * Find prices inside THIS product card only.
         */
        const priceMatches = [
          ...cardText.matchAll(
            /\$\s*([0-9]{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/g
          ),
        ];

        const prices = priceMatches
          .map((match) => {
            const raw = match[1].replace(/,/g, "");
            return Number(raw);
          })
          .filter(
            (price) =>
              Number.isFinite(price) &&
              price > 0 &&
              price < 100000
          );

        const uniquePrices = [...new Set(prices)];

        if (
          !title ||
          title.length < 10 ||
          !uniquePrices.length
        ) {
          continue;
        }

        /*
         * Prefer a normal retail price.
         *
         * Walmart sometimes exposes values such as:
         * $0.00
         * $21.99
         * $2199
         *
         * We ignore zero and use the first valid candidate.
         */
        const price = uniquePrices[0];

        if (!Number.isFinite(price) || price <= 0) {
          continue;
        }

        const lowerTitle = title.toLowerCase();

        let condition = "new";

        if (/\bopen box\b/i.test(lowerTitle)) {
          condition = "open_box";
        } else if (/\brefurbished\b|\brenewed\b/i.test(lowerTitle)) {
          condition = "refurbished";
        } else if (/\bused\b/i.test(lowerTitle)) {
          condition = "used";
        }

        extracted.push({
          title: title.slice(0, 500),
          price,
          url: href,
          sku,
          model: null,
          condition,
        });
      }

      return extracted;
    }, maxItems);

    /*
     * Convert extracted Walmart search results into the
     * standard product format used by the rest of the scraper.
     */
    const finalResults = results.map((product, index) => {
      console.log(
          `  [walmart] #${index + 1} ${product.title.slice(
            0,
            120
          )} | $${product.price} | SKU: ${
            product.sku || "N/A"
          } | Model: ${product.model || "N/A"} | Condition: ${
            product.condition || "new"
          }`
        );

      return {
        source: "walmart",
        retailer: "Walmart",
        title: product.title,
        price: product.price,
        url: product.url,
        sku: product.sku || null,
        model: product.model || null,
        condition: product.condition || "new",
      };
    });

    console.log("\n  [walmart] raw URL diagnostics:");

    for (const [index, product] of results.entries()) {
      console.log(
        `  [walmart] ${index + 1}. SKU=${product.sku || "N/A"}`
      );
      console.log(
        `       TITLE=${product.title.slice(0, 150)}`
      );
      console.log(
        `       URL=${product.url}`
      );
    }

    console.log(
      `  [walmart] extracted ${finalResults.length} products from ${products.length} candidate product links`
    );

    return finalResults;
  } catch (error) {
    console.warn(
      `  [walmart] scan failed — ${String(
        error?.message || error
      )
        .replace(/\s+/g, " ")
        .slice(0, 300)}`
    );

    return [];
  } finally {
    await context.close();
  }
}


// ============================================================
// IMPROVED extractModelNumber - handles more patterns
// ============================================================
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

async function scrapeEbaySoldComps(query, maxItems = 20) {
  const apiKey = process.env.SOLDCOMPS_API_KEY;

  if (!apiKey) {
    console.warn(
      "  [ebay-sold] SOLDCOMPS_API_KEY is missing"
    );
    return [];
  }

  const normalizedQuery = String(query || "")
    .trim()
    .toLowerCase();

  if (!normalizedQuery) {
    console.warn(
      "  [ebay-sold] empty query; skipping"
    );
    return [];
  }

  /*
   * Reuse results if the exact same query has already
   * been requested during this run.
   */
  if (soldCompsCache.has(normalizedQuery)) {
    console.log(
      `  [ebay-sold] cache hit: ${query}`
    );

    return soldCompsCache.get(normalizedQuery);
  }

  /*
   * HARD REQUEST LIMIT.
   *
   * We have 56 requests remaining.
   * We intentionally allow at most 45 new requests
   * from this run, leaving 11 as a safety buffer.
   */
  if (
    soldCompsRequestsThisRun >=
    SOLD_COMPS_MAX_REQUESTS_TODAY
  ) {
    console.warn(
      `  [ebay-sold] REQUEST LIMIT REACHED ` +
      `(${SOLD_COMPS_MAX_REQUESTS_TODAY}). ` +
      `Skipping: ${query}`
    );

    return [];
  }

  soldCompsRequestsThisRun++;

  console.log(
    `  [ebay-sold] request ` +
    `${soldCompsRequestsThisRun}/${SOLD_COMPS_MAX_REQUESTS_TODAY}: ` +
    `${query}`
  );

  const params = new URLSearchParams({
    keyword: query,
    ebaySite: "ebay.com",
    page: "1",
    count: String(maxItems),
    sortOrder: "endedRecently",
    exactMatch: "true",
  });

  const url =
    `https://api.sold-comps.com/v1/scrape?${params.toString()}`;

  try {
    console.log(
      `  [ebay-sold] SoldComps API searching: ${query}`
    );

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    console.log(
      `  [ebay-sold] HTTP status: ${response.status}`
    );

    const body = await response.text();

    if (!response.ok) {
      console.error(
        `  [ebay-sold] API error: ${body.slice(0, 1000)}`
      );
      return [];
    }

    let data;

    try {
      data = JSON.parse(body);
    } catch {
      console.error(
        "  [ebay-sold] API returned invalid JSON"
      );
      return [];
    }

    let listings = [];

    if (Array.isArray(data)) {
      listings = data;
    } else if (Array.isArray(data.results)) {
      listings = data.results;
    } else if (Array.isArray(data.items)) {
      listings = data.items;
    } else if (Array.isArray(data.data)) {
      listings = data.data;
    } else if (Array.isArray(data.listings)) {
      listings = data.listings;
    }

    console.log(
      `  [ebay-sold] API returned ${listings.length} raw listings`
    );

    const results = [];

    for (const item of listings) {
      if (
        item.listingType &&
        String(item.listingType).toLowerCase() !== "sold"
      ) {
        continue;
      }

      const soldPrice = Number(
        item.soldPrice ??
        item.price ??
        item.totalPrice
      );

      if (
        !Number.isFinite(soldPrice) ||
        soldPrice <= 0
      ) {
        continue;
      }

      const shippingPrice = Number(
        item.shippingPrice ?? 0
      );

      const totalPrice = Number(
        item.totalPrice ??
        (soldPrice + shippingPrice)
      );

      if (
        !Number.isFinite(totalPrice) ||
        totalPrice <= 0
      ) {
        continue;
      }

      results.push({
        itemId: item.itemId ?? null,
        url: item.url ?? null,

        thumbnailUrl:
          item.thumbnailUrl ?? null,

        fullResThumbnailUrl:
          item.fullResThumbnailUrl ?? null,

        epid: item.epid ?? null,

        title:
          typeof item.title === "string"
            ? item.title.trim()
            : "",

        condition:
          item.condition ?? null,

        conditionId:
          item.conditionId ?? null,

        listingType: "sold",

        endedAt:
          item.endedAt ?? null,

        soldPrice,

        soldCurrency:
          item.soldCurrency ?? "USD",

        shippingPrice,

        shippingCurrency:
          item.shippingCurrency ?? "USD",

        shippingType:
          item.shippingType ?? null,

        totalPrice,

        sellerUsername:
          item.sellerUsername ?? null,

        sellerPositivePercent:
          item.sellerPositivePercent ?? null,

        sellerFeedbackScore:
          item.sellerFeedbackScore ?? null,

        itemLocation:
          item.itemLocation ?? null,

        scrapedAt:
          item.scrapedAt ??
          new Date().toISOString(),
      });

      if (results.length >= maxItems) {
        break;
      }
    }

    console.log(
      `  [ebay-sold] extracted ${results.length} sold comps`
    );

    for (
      const [index, item] of results.entries()
    ) {
      console.log(
        `  [ebay-sold] #${index + 1} ` +
        `${item.title} | ` +
        `$${item.totalPrice.toFixed(2)}` +
        `${
          item.condition
            ? ` | ${item.condition}`
            : ""
        }` +
        `${
          item.endedAt
            ? ` | Sold: ${item.endedAt}`
            : ""
        }`
      );
    }

    soldCompsCache.set(
      normalizedQuery,
      results
    );

    return results;

  } catch (error) {
    console.error(
      `  [ebay-sold] failed: ${error.message}`
    );

    return [];
  }
}

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

function safeScrape(name, scraper, browser, query, maxItems, failures) {
  console.log(`  🔎 ${name}: scanning...`);
  return scraper(browser, query, maxItems)
    .then((results) => {
      console.log(`  ✓ ${name}: ${results.length} products`);
      return results;
    })
    .catch((error) => {
      const message = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
      console.warn(`  ⚠ ${name}: skipped — ${message}`);
      failures.push({ storeName: name, query, error: message });
      return [];
    });
}

function enabledScrapers(budget) {
  return [
    ["Best Buy", "bestbuy", budget.enableBestBuy, scrapeBestBuy],
    ["Walmart", "walmart", true, scrapeWalmart],
  ].filter(([, , enabled]) => enabled);
}
function selectProductsForSoldComps(
  products,
  maxProducts = 10
) {
  const candidates = [];

  for (const product of products) {
    const title = String(
      product.title || ""
    ).trim();

    if (!title) {
      continue;
    }

    const price = Number(
      product.price
    );

    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      continue;
    }

    /*
     * Avoid wasting SoldComps requests
     * on extremely cheap products.
     */
    if (price < 10) {
      continue;
    }

    /*
     * Keep this regex on ONE line.
     *
     * These are brands that are more likely
     * to have recognizable resale demand.
     */
    const hasBrand =
      /\b(apple|samsung|sony|bose|jbl|lg|lenovo|dell|hp|asus|acer|logitech|corsair|razer|steelseries|dewalt|milwaukee|makita|ryobi|ridgid|craftsman|greenworks|worx|vevor|kobalt|bosch|skil|dyson|shark|keurig|ninja|vitamix|kitchenaid|canon|nikon|gopro|garmin|fitbit|anker)\b/i.test(
        title
      );

    const isClearance =
      product.clearance === true ||
      product.isClearance === true;

    const isOpenBox =
      product.isOpenBox === true;

    const isSale =
      product.isSale === true;

    let score = 0;

    /*
     * Recognizable brand.
     */
    if (hasBrand) {
      score += 30;
    }

    /*
     * Clearance is highly valuable
     * for the discovery workflow.
     */
    if (isClearance) {
      score += 30;
    }

    /*
     * Open-box products can have
     * significant resale spreads.
     */
    if (isOpenBox) {
      score += 15;
    }

    /*
     * Sale/deal products are also
     * worth checking.
     */
    if (isSale) {
      score += 10;
    }

    /*
     * Avoid spending API calls on
     * extremely low-value items.
     */
    if (price >= 30) {
      score += 10;
    }

    if (price >= 50) {
      score += 5;
    }

    candidates.push({
      product,
      score,
    });
  }

  /*
   * Highest-scoring products first.
   *
   * Price is the tie-breaker.
   */
  return candidates
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return (
        Number(
          b.product.price || 0
        ) -
        Number(
          a.product.price || 0
        )
      );
    })
    .slice(0, maxProducts)
    .map(
      ({ product }) => product
    );
}
async function scrapeBestBuySpecificUrl(
  browser,
  bestBuyUrl,
  maxItems = 10
) {
  console.log(
    `  [bestbuy] SPECIFIC PRODUCT URL: ${bestBuyUrl}`
  );

  /*
   * ---------------------------------------------------------
   * EXTRACT SKU FROM THE USER-PROVIDED URL
   * ---------------------------------------------------------
   *
   * Example:
   * /product/.../6610891/openbox?condition=fair
   *
   * SKU = 6610891
   */

  const skuMatch = bestBuyUrl.match(
    /\/(\d{6,})\/(?:openbox)?(?:\?|$)/i
  );

  const sku =
    skuMatch
      ? skuMatch[1]
      : null;

  if (!sku) {
    throw new Error(
      "Could not extract a Best Buy SKU from --best-buy-url"
    );
  }

  console.log(
    `  [bestbuy] extracted SKU: ${sku}`
  );

  /*
   * ---------------------------------------------------------
   * SEARCH BY SKU INSTEAD OF OPENING PRODUCT PAGE
   * ---------------------------------------------------------
   */

  const searchUrl =
    `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(
      sku
    )}&intl=nosplash`;

  if (
    !(await robotsAllowed(
      searchUrl,
      "bestbuy"
    ))
  ) {
    console.warn(
      "  [bestbuy] robots.txt disallowed SKU search URL"
    );

    return [];
  }

  const context =
    await browser.newContext({
      viewport: {
        width: 1440,
        height: 900,
      },

      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/151.0.0.0 Safari/537.36",

      locale: "en-US",

      timezoneId:
        "America/Chicago",

      extraHTTPHeaders: {
        "Accept-Language":
          "en-US,en;q=0.9",
      },
    });

  const page =
    await context.newPage();

  try {
    console.log(
      `  [bestbuy] searching by SKU: ${sku}`
    );

    await page.goto(
      searchUrl,
      {
        waitUntil:
          "domcontentloaded",
        timeout: 45000,
      }
    );

    await page.waitForTimeout(5000);

    console.log(
      `  [bestbuy] search title: ${await page.title()}`
    );

    console.log(
      `  [bestbuy] search url: ${page.url()}`
    );

    /*
     * -------------------------------------------------------
     * COUNTRY REDIRECT CHECK
     * -------------------------------------------------------
     */

    const currentUrl =
      page.url();

    const pageTitle =
      await page.title();

    if (
      currentUrl
        .toLowerCase()
        .includes("international") ||
      pageTitle
        .toLowerCase()
        .includes("select your country")
    ) {
      console.warn(
        "  [bestbuy] SKU search redirected to international page."
      );

      return [];
    }

    /*
     * -------------------------------------------------------
     * FIND PRODUCT LINK
     * -------------------------------------------------------
     */

    const productLinks =
      await page.evaluate(
        (targetSku) => {
          const anchors =
            Array.from(
              document.querySelectorAll(
                'a[href*="/site/"]'
              )
            );

          const results = [];

          for (
            const a of anchors
          ) {
            const href =
              a.href || "";

            const text =
              (a.textContent || "")
                .replace(/\s+/g, " ")
                .trim();

            if (!href || !text) {
              continue;
            }

            /*
             * Best Buy product URLs:
             *
             * /site/product-name/123456.p
             */

            const skuMatch =
              href.match(
                /\/(\d{6,})\.p(?:\?|$)/i
              );

            if (!skuMatch) {
              continue;
            }

            const foundSku =
              skuMatch[1];

            /*
             * Prefer exact SKU.
             */

            if (
              foundSku === targetSku
            ) {
              results.push({
                href,
                title: text,
                sku: foundSku,
                exactSku: true,
              });

              continue;
            }

            /*
             * Also retain links whose
             * visible text contains SKU.
             */

            if (
              text.includes(
                targetSku
              )
            ) {
              results.push({
                href,
                title: text,
                sku: foundSku,
                exactSku: false,
              });
            }
          }

          return results;
        },
        sku
      );

    console.log(
      `  [bestbuy] SKU search found ${productLinks.length} candidate product links`
    );

    for (
      const [
        index,
        link,
      ] of productLinks
        .slice(0, 10)
        .entries()
    ) {
      console.log(
        `  [bestbuy] candidate #${
          index + 1
        }: ${link.title} | ${link.href}`
      );
    }

    if (
      productLinks.length === 0
    ) {
      console.warn(
        `  [bestbuy] no product link found for SKU ${sku}`
      );

      /*
       * Save diagnostics so we can inspect
       * what Best Buy actually returned.
       */

      await debugSnapshot(
        "bestbuy-specific",
        `sku-${sku}`,
        page
      );

      return [];
    }

    /*
     * -------------------------------------------------------
     * PREFER EXACT SKU
     * -------------------------------------------------------
     */

    const exact =
      productLinks.find(
        (item) =>
          item.exactSku
      ) ||
      productLinks[0];

    /*
     * -------------------------------------------------------
     * EXTRACT PRODUCT CARD DIRECTLY
     * -------------------------------------------------------
     *
     * We intentionally DO NOT navigate to the product page.
     */

    const product =
      await page.evaluate(
        (targetSku) => {
          const anchors =
            Array.from(
              document.querySelectorAll(
                'a[href*="/site/"]'
              )
            );

          for (
            const a of anchors
          ) {
            const href =
              a.href || "";

            const match =
              href.match(
                /\/(\d{6,})\.p(?:\?|$)/i
              );

            if (
              !match ||
              match[1] !== targetSku
            ) {
              continue;
            }

            const title =
              (a.textContent || "")
                .replace(/\s+/g, " ")
                .trim();

            if (
              !title ||
              title.length < 5
            ) {
              continue;
            }

            /*
             * Walk upward to find
             * the product card.
             */

            let element = a;
            let block = "";

            for (
              let depth = 0;
              depth < 10 &&
              element;
              depth++
            ) {
              const text =
                (
                  element.textContent ||
                  ""
                )
                  .replace(
                    /\s+/g,
                    " "
                  )
                  .trim();

              if (
                /\$\s*[0-9]+(?:\.[0-9]{1,2})?/
                  .test(text)
              ) {
                block = text;
                break;
              }

              element =
                element.parentElement;
            }

            if (!block) {
              block =
                (
                  a.parentElement
                    ?.textContent ||
                  ""
                )
                  .replace(
                    /\s+/g,
                    " "
                  )
                  .trim();
            }

            /*
             * PRICE
             */

            const priceMatches =
              [
                ...block.matchAll(
                  /\$\s*([0-9]+(?:\.[0-9]{1,2})?)/g
                ),
              ]
                .map(
                  (m) =>
                    Number(m[1])
                )
                .filter(
                  (value) =>
                    Number.isFinite(
                      value
                    ) &&
                    value > 1
                );

            if (
              priceMatches.length === 0
            ) {
              continue;
            }

            const price =
              priceMatches[0];

            /*
             * RATING
             */

            const ratingMatch =
              block.match(
                /([0-5](?:\.[0-9]+)?)\s*(?:out of 5|stars)/i
              );

            const rating =
              ratingMatch
                ? Number(
                    ratingMatch[1]
                  )
                : null;

            /*
             * REVIEW COUNT
             */

            const reviewMatches =
              [
                ...block.matchAll(
                  /\(([0-9][0-9,]*)\)/g
                ),
              ];

            let reviewCount = 0;

            if (
              reviewMatches.length
            ) {
              const last =
                reviewMatches[
                  reviewMatches.length - 1
                ][1];

              const value =
                Number(
                  last.replace(
                    /,/g,
                    ""
                  )
                );

              if (
                Number.isFinite(
                  value
                )
              ) {
                reviewCount =
                  value;
              }
            }

            /*
             * MODEL NUMBER
             */

            const modelMatch =
              block.match(
                /\b(?:model|model number|mfr part number|manufacturer part number)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})\b/i
              );

            const model =
              modelMatch
                ? modelMatch[1]
                : null;

            const lower =
              block.toLowerCase();

            /*
             * DEAL FLAGS
             */

            const isClearance =
              lower.includes(
                "clearance"
              );

            const isOpenBox =
              lower.includes(
                "open-box"
              ) ||
              lower.includes(
                "open box"
              );

            const isSale =
              lower.includes(
                "sale"
              ) ||
              lower.includes(
                "deal"
              ) ||
              lower.includes(
                "save $"
              ) ||
              lower.includes(
                "discount"
              );

            /*
             * SAVINGS
             */

            const savingsMatch =
              block.match(
                /save\s*\$\s*([0-9]+(?:\.[0-9]{1,2})?)/i
              );

            const savings =
              savingsMatch
                ? Number(
                    savingsMatch[1]
                  )
                : null;

            return {
              source:
                "bestbuy",

              storeName:
                "Best Buy",

              title,

              price,

              sku:
                targetSku,

              model,

              /*
               * Normal Best Buy product
               * URL from the search result.
               */

              url: href,

              rating,

              reviewCount,

              rawDescription:
                block,

              /*
               * This is specifically an
               * open-box Fair URL supplied
               * by the user.
               */

              sourceProductUrl:
                window.location.href,

              requestedUrl:
                null,

              clearance:
                Boolean(
                  isClearance
                ),

              isClearance:
                Boolean(
                  isClearance
                ),

              isOpenBox:
                Boolean(
                  isOpenBox
                ),

              isSale:
                Boolean(
                  isSale
                ),

              comparableValue:
                null,

              savings,
            };
          }

          return null;
        },
        sku
      );

    if (!product) {
      console.warn(
        `  [bestbuy] exact SKU ${sku} was found but product data could not be extracted.`
      );

      return [];
    }

    /*
     * -------------------------------------------------------
     * PRESERVE THE USER'S ORIGINAL OPEN-BOX URL
     * -------------------------------------------------------
     */

    product.requestedUrl =
      bestBuyUrl;

    product.sourceProductUrl =
      bestBuyUrl;

    /*
     * Explicitly identify the requested
     * condition from the URL.
     */

    const conditionMatch =
      bestBuyUrl.match(
        /[?&]condition=([^&]+)/i
      );

    if (
      conditionMatch
    ) {
      product.openBoxCondition =
        decodeURIComponent(
          conditionMatch[1]
        );
    }

    /*
     * This product was supplied as
     * an Open Box URL, so mark it.
     */

    product.isOpenBox =
      true;

    /*
     * Do NOT call the entire search result
     * "clearance" just because it came from
     * this special URL.
     */

    product.clearance =
      false;

    product.isClearance =
      false;

    console.log(
      `  [bestbuy] MATCHED PRODUCT`
    );

    console.log(
      `  [bestbuy] ${product.title}`
    );

    console.log(
      `  [bestbuy] price: $${product.price}`
    );

    console.log(
      `  [bestbuy] SKU: ${product.sku}`
    );

    console.log(
      `  [bestbuy] model: ${
        product.model || "N/A"
      }`
    );

    console.log(
      `  [bestbuy] condition: ${
        product.openBoxCondition ||
        "open-box"
      }`
    );

    console.log(
      `  [bestbuy] product URL: ${product.url}`
    );

    console.log(
      `  [bestbuy] requested URL: ${bestBuyUrl}`
    );

    return [
      product,
    ].slice(
      0,
      maxItems
    );
  } finally {
    await context.close();
  }
}

async function scanQuery({
  args,
  budget,
  inRadius,
  browser,
  query,
}) {
  const productsRaw = [];
  const storeFailures = [];
  const scraperCounts = {};

  /*
   * ------------------------------------------------------------
   * EFFECTIVE QUERY
   * ------------------------------------------------------------
   *
   * Normal mode:
   *   use the user's query.
   *
   * Clearance mode:
   *   do NOT search for "drill" or any other default query.
   *   Best Buy's clearance page is used directly.
   */

  const effectiveQuery =
  args.clearance === true
    ? ""
    : String(query || "").trim();

const hasBestBuyUrl =
  Boolean(
    args.bestBuyUrl &&
    args.bestBuyUrl.trim()
  );

if (
      args.clearance !== true &&
      !args.bestBuyUrl &&
      !effectiveQuery
    ) {
      throw new Error(
        "A search query, --best-buy-url, or --clearance is required."
      );
    }

  const scrapers = enabledScrapers(
    budget
  );

  /*
   * ------------------------------------------------------------
   * RETAILER SCRAPING
   * ------------------------------------------------------------
   */

  for (
    const [
      displayName,
      source,
      enabled,
      scraper,
    ] of scrapers
  ) {
    if (!enabled) {
      continue;
    }

    /*
     * Clearance discovery currently uses Best Buy's
     * actual clearance inventory page.
     *
     * Do NOT send an empty search query to other
     * retailers.
     */
    if (
      args.clearance === true &&
      source !== "bestbuy"
    ) {
      continue;
    }

    let results = [];

    try {
      /*
       * Best Buy receives the clearance flag directly.
       */
      if (source === "bestbuy") {
        if (args.bestBuyUrl) {
          results = await scrapeBestBuySpecificUrl(
            browser,
            args.bestBuyUrl,
            budget.maxItemsPerStore
          );
        } else {
          results = await scraper(
            browser,
            effectiveQuery,
            budget.maxItemsPerStore,
            args.clearance === true
          );
        }
      }else {
        /*
         * Normal retailer scraping.
         */
        results = await safeScrape(
          displayName,
          scraper,
          browser,
          effectiveQuery,
          budget.maxItemsPerStore,
          storeFailures
        );
      }
    } catch (error) {
      console.warn(
        `  [${source}] scraper failed: ${
          error.message || error
        }`
      );

      storeFailures.push({
        source,
        displayName,
        error:
          error.message ||
          String(error),
      });

      results = [];
    }

    scraperCounts[source] =
      (scraperCounts[source] || 0) +
      results.length;

    for (
      const product of results
    ) {
      productsRaw.push({
        ...product,
        searchQuery:
        effectiveQuery ||
        args.bestBuyUrl ||
        null,
      });
    }
  }

  /*
   * ------------------------------------------------------------
   * LOCAL STORE CONTEXT
   * ------------------------------------------------------------
   */

  const products =
    attachLocalStoreContext(
      productsRaw,
      inRadius
    );

  /*
   * ------------------------------------------------------------
   * PRODUCT-SPECIFIC EBAY SOLD COMPS
   * ------------------------------------------------------------
   *
   * We do NOT simply take the first 10 products anymore.
   *
   * Clearance discovery can produce many different products,
   * so we prioritize products that are more useful to evaluate:
   *
   *   - recognizable brands
   *   - clearance items
   *   - open-box items
   *   - sale items
   *   - products with enough purchase value
   */

  const soldComps = [];
  const soldCompSeen =
    new Set();

  const compProducts =
    selectProductsForSoldComps(
      products,
      args.clearance === true
        ? 15
        : 10
    );

  console.log(
    `[ebay-sold] selected ${compProducts.length} products for sold-comps analysis`
  );

  for (
    const [
      index,
      product,
    ] of compProducts.entries()
  ) {
    console.log(
      `[ebay-sold] candidate #${
        index + 1
      }: ${
        product.title
      } | $${product.price}`
    );
  }

  for (
    const product of compProducts
  ) {
    const productQuery = [
      product.title,
      product.model,
    ]
      .filter(Boolean)
      .join(" ");

    if (!productQuery.trim()) {
      continue;
    }

    console.log(
      `[ebay-sold] searching comps for: ${productQuery}`
    );

    try {
      const comps =
        await scrapeEbaySoldComps(
          productQuery,
          20
        );

      for (
        const comp of comps
      ) {
        const key =
          comp.url ||
          [
            comp.title,
            comp.price,
            comp.soldDate,
          ].join("|");

        if (
          soldCompSeen.has(key)
        ) {
          continue;
        }

        soldCompSeen.add(key);

        soldComps.push({
          ...comp,

          matchedSearchQuery:
            productQuery,

          matchedSourceProduct:
            product.title,

          matchedSourceSku:
            product.sku || null,

          matchedSourceModel:
            product.model || null,
        });
      }

      /*
       * Prevent hammering the API.
       */
      await new Promise(
        (resolve) =>
          setTimeout(resolve, 750)
      );
    } catch (error) {
      console.warn(
        `[ebay-sold] failed for "${productQuery}": ${
          error.message || error
        }`
      );
    }
  }

  console.log(
    `[ebay-sold] total product-specific sold comps: ${soldComps.length}`
  );

  /*
   * ------------------------------------------------------------
   * BUILD CANDIDATES
   * ------------------------------------------------------------
   */

  const built =
    buildCandidates(
      products,
      args.minProfitPct,
      {
        sellFeePct:
          args.sellFeePct,

        shippingCost:
          args.shippingCost,

        soldComps,
      }
    );

  /*
   * ------------------------------------------------------------
   * RETURN REPORT
   * ------------------------------------------------------------
   */

  return {
    generatedAt:
      new Date().toISOString(),

    query:
      effectiveQuery,

    clearance:
      args.clearance === true,

    productsScraped:
      products.length,

    productsWithLocalStore:
      products.filter(
        (p) =>
          p.localStoreFound &&
          p.localStore?.withinCedarFallsRadius
      ).length,

    candidateCount:
      built.candidates.length,

    candidates:
      built.candidates,

    promisingLeadCount:
      (built.leads || []).length,

    promisingLeads:
      built.leads || [],

    nearMisses:
      built.nearMisses,

    diagnostics:
      built.diagnostics,

    scraperCounts,

    storeFailures,

    /*
     * Keep all useful product information.
     */
    products:
      products.map((p) => ({
        source:
          p.source,

        sourceType:
          p.localSourceType ||
          "national_or_online",

        storeName:
          p.storeName,

        title:
          p.title,

        price:
          p.price,

        sku:
          p.sku,

        model:
          p.model,

        url:
          p.url,

        searchQuery:
          p.searchQuery,

        clearance:
          p.clearance === true,

        isClearance:
          p.isClearance === true,

        isOpenBox:
          p.isOpenBox === true,

        isSale:
          p.isSale === true,

        localStore:
          p.localStore,
      })),
  };
}

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
          `   Gross spread: ${n.estimatedProfitPct.toFixed(1)}% | Identity: ${
            n.identityScore
          }/100 | Confidence: ${n.confidence}`
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
      `   Gross spread: ${c.estimatedProfitPct.toFixed(1)}% | Net est.: ${
        c.estimatedNetProfitPct
      }% | Confidence: ${c.confidence}`
    );
    console.log(
      `   Sellability: ${c.sellabilityScore} | Local inventory: MANUAL VERIFY`
    );

    if (c.suspiciousSpread) {
      console.log(
        `   WARNING: unusually large price spread; verify exact SKU/model/packaging.`
      );
    }

    console.log(`   Buy:  ${c.buyUrl}`);
    console.log(`   Comp: ${c.compUrl}`);
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

  const queries = args.clearance
    ? ["__BESTBUY_CLEARANCE__"]
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
        (b.estimatedProfitPct - a.estimatedProfitPct) ||
        (b.confidence - a.confidence)
    );

  const promisingLeads = queryReports
    .flatMap(r => r.promisingLeads || [])
    .sort(
      (a, b) =>
        (b.estimatedProfitPct - a.estimatedProfitPct) ||
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
    queries: args.clearance ? ["BEST BUY CLEARANCE"] : queries,

    clearanceMode: Boolean(args.clearance),

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
      "(comparison price - buy price) / buy price * 100; this is a gross price spread, not guaranteed net profit.",

    sourcePolicy:
      "robots.txt is checked before requests; 403/CAPTCHA/unknown robots are fail-closed.",

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
    `${args.minProfitPct}%+ candidates: ${candidates.length}`
  );

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
