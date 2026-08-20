const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const CEDAR_FALLS = { lat: 42.5349, lon: -92.4453 };
const DEFAULT_RADIUS_MILES = 100;

// Store-specific zip codes for local inventory lookups
const STORE_ZIPS = {
  "walmart": "50613",
  "target": "50613",
  "homedepot": "50613",
  "lowes": "50701",
  "menards": "50613",
  "harborfreight": "50701",
  "fleetfarm": "50613",
  "northerntool": "52402",
  "dollar_general": "50613",
  "ollies": "52240",
  "biglots": "50707",
  "fivebelow": "50701",
  "tjx": "50701",
  "burlington": "52241",
  "marshalls": "52402",
  "sierra": "52402",
  "ross": "52241",
  "hobbylobby": "50613",
};

// High-margin categories to target
const PROFITABLE_CATEGORIES = [
  "drill", "circular saw", "impact driver", "combo kit",
  "sander", "router", "jigsaw", "angle grinder",
  "bluetooth speaker", "headphones", "charger",
  "desk lamp", "fan", "heater", "air purifier",
  "tool box", "storage", "organizer",
];

const CITY_CENTROIDS = {
  "cedar falls,ia": { lat: 42.5349, lon: -92.4453 },
  "waterloo,ia": { lat: 42.4928, lon: -92.3426 },
  "cedar rapids,ia": { lat: 41.9779, lon: -91.6656 },
  "coralville,ia": { lat: 41.6764, lon: -91.5804 },
  "iowa city,ia": { lat: 41.6611, lon: -91.5302 },
  "williamsburg,ia": { lat: 41.6608, lon: -92.0074 },
  "polk city,ia": { lat: 41.7719, lon: -93.7124 },
  "ankeny,ia": { lat: 41.7318, lon: -93.6001 },
};

function parseArgs(argv) {
  const args = {
    query: "drill",
    maxItemsPerStore: 25,
    minProfitPct: 50,
    topN: 5,
    jsonOut: "",
    headed: false,
    creditUsagePct: Number(process.env.GITHUB_CREDITS_USED_PCT || 0),
    budgetMode: "auto",
    refresh: false,
    category: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--query" && argv[i + 1]) args.query = argv[++i];
    else if (v === "--max-items-per-store" && argv[i + 1]) args.maxItemsPerStore = Number(argv[++i]);
    else if (v === "--min-profit-pct" && argv[i + 1]) args.minProfitPct = Number(argv[++i]);
    else if (v === "--top-n" && argv[i + 1]) args.topN = Number(argv[++i]);
    else if (v === "--json-out" && argv[i + 1]) args.jsonOut = argv[++i];
    else if (v === "--headed") args.headed = true;
    else if (v === "--credit-usage-pct" && argv[i + 1]) args.creditUsagePct = Number(argv[++i]);
    else if (v === "--budget-mode" && argv[i + 1]) args.budgetMode = String(argv[++i]).toLowerCase();
    else if (v === "--refresh") args.refresh = true;
    else if (v === "--category" && argv[i + 1]) args.category = argv[++i];
  }

  return args;
}

function resolveBudgetProfile(args) {
  const mode = ["auto", "normal", "low", "aggressive"].includes(args.budgetMode)
    ? args.budgetMode
    : "auto";
  const credits = Number.isFinite(args.creditUsagePct) ? args.creditUsagePct : 0;

  if (mode === "low" || (mode === "auto" && credits >= 90)) {
    return {
      mode: "low",
      maxItemsPerStore: Math.max(8, Math.min(args.maxItemsPerStore, 12)),
      useCache: true,
      cacheTtlMinutes: 24 * 60,
      enableWalmart: false,
      enableTarget: true,
      enableBestBuy: true,
      enableHarborFreight: true,
      enableHomeDepot: true,
      enableLowes: true,
      enableMenards: false, // often bot-protected
      enableDollarGeneral: false, // low value items
      enableOllie: true,
      enableFiveBelow: true,
      enableTJX: true,
      enableHobbyLobby: false,
      enableBigLots: false,
    };
  }

  if (mode === "aggressive") {
    return {
      mode: "aggressive",
      maxItemsPerStore: Math.max(20, args.maxItemsPerStore),
      useCache: false,
      cacheTtlMinutes: 90,
      enableWalmart: true,
      enableTarget: true,
      enableBestBuy: true,
      enableHarborFreight: true,
      enableHomeDepot: true,
      enableLowes: true,
      enableMenards: false,
      enableDollarGeneral: true,
      enableOllie: true,
      enableFiveBelow: true,
      enableTJX: true,
      enableHobbyLobby: true,
      enableBigLots: true,
    };
  }

  return {
    mode: "normal",
    maxItemsPerStore: args.maxItemsPerStore,
    useCache: true,
    cacheTtlMinutes: 90,
    enableWalmart: false, // often blocked
    enableTarget: true,
    enableBestBuy: true,
    enableHarborFreight: true,
    enableHomeDepot: true,
    enableLowes: true,
    enableMenards: false,
    enableDollarGeneral: false,
    enableOllie: true,
    enableFiveBelow: true,
    enableTJX: true,
    enableHobbyLobby: false,
    enableBigLots: false,
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
  return rows.filter((r) => {
    const key = `${String(r.city).toLowerCase()},${String(r.state).toLowerCase()}`;
    const c = CITY_CENTROIDS[key];
    if (!c) return false;
    const dist = haversineMiles(CEDAR_FALLS.lat, CEDAR_FALLS.lon, c.lat, c.lon);
    return dist <= radiusMiles;
  });
}

async function robotsAllowed(url) {
  try {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    const txt = await fetch(robotsUrl, { redirect: "follow" }).then((r) => r.text());

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
      if (u.pathname.startsWith(rule)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

function cleanPrice(value) {
  if (typeof value === "number") return value;
  const m = String(value || "").match(/([0-9]+(?:\.[0-9]{1,2})?)/);
  return m ? Number(m[1]) : NaN;
}

function decodeWalmartUrl(url) {
  try {
    const u = new URL(url);
    const rd = u.searchParams.get("rd");
    if (rd) return decodeURIComponent(rd);
    if (url.startsWith("/")) return `https://www.walmart.com${url}`;
    return url;
  } catch {
    if (url.startsWith("/")) return `https://www.walmart.com${url}`;
    return url;
  }
}

async function scrapeWalmart(browser, query, maxItems) {
  const searchUrl = `https://www.walmart.com/search?q=${encodeURIComponent(query)}`;
  if (!(await robotsAllowed(searchUrl))) return [];

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3500);

  const rows = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/ip/"]'));
    const out = [];

    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const titleText = (a.textContent || "").replace(/\s+/g, " ").trim();
      const card = a.closest("[data-item-id]") || a.closest("div");
      const block = (card?.textContent || "").replace(/\s+/g, " ");

      let priceMatch = block.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
      if (!priceMatch) {
        priceMatch = titleText.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
      }
      if (!priceMatch) continue;

      const price = Number(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 0) continue;

      const title = titleText.replace(/\$\s*[0-9]+(?:\.[0-9]{2})?.*$/, "").trim();
      if (!title || title.length < 10) continue;

      const skuMatch = href.match(/\/(\d{6,})/);
      const sku = skuMatch ? skuMatch[1] : "";

      const ratingMatch = block.match(/([0-5](?:\.[0-9])?)\s*out of\s*5\s*Stars/i);
      const rating = ratingMatch ? Number(ratingMatch[1]) : null;
      const reviewsMatch = block.match(/([0-9][0-9,]*)\s*reviews?/i);
      const reviewCount = reviewsMatch ? Number(reviewsMatch[1].replace(/,/g, "")) : 0;

      out.push({
        source: "walmart",
        storeName: "Walmart",
        title,
        price,
        sku,
        url: href,
        rating,
        reviewCount,
      });
    }

    return out;
  });

  await context.close();

  const dedup = new Map();
  for (const r of rows) {
    const key = `${normalize(r.title)}|${r.sku}`;
    if (!dedup.has(key)) {
      r.url = decodeWalmartUrl(r.url);
      dedup.set(key, r);
    }
    if (dedup.size >= maxItems) break;
  }

  return Array.from(dedup.values()).slice(0, maxItems);
}

async function scrapeBestBuy(browser, query, maxItems) {
  const searchUrl = `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(query)}&intl=nosplash`;
  if (!(await robotsAllowed(searchUrl))) return [];

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3500);

  const rows = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/product/"]'));
    const out = [];

    for (const a of anchors) {
      const href = a.href || "";
      if (!href.includes("/product/")) continue;
      if (href.includes("#tabbed-customerreviews")) continue;

      const title = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || title.length < 10) continue;

      const card = a.closest("li") || a.closest("article") || a.closest("div");
      const block = (card?.textContent || "").replace(/\s+/g, " ");
      const priceMatch = block.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
      if (!priceMatch) continue;

      const price = Number(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 0) continue;

      const skuMatch = href.match(/\/sku\/(\d+)/i);
      const sku = skuMatch ? skuMatch[1] : "";

      const ratingMatch = block.match(/rating\s*,?\s*([0-5](?:\.[0-9]+)?)\s*out of\s*5\s*stars/i);
      const rating = ratingMatch ? Number(ratingMatch[1]) : null;
      const reviewsMatch = block.match(/\(([0-9][0-9,]*)\)/);
      const reviewCount = reviewsMatch ? Number(reviewsMatch[1].replace(/,/g, "")) : 0;

      out.push({
        source: "bestbuy",
        storeName: "Best Buy",
        title,
        price,
        sku,
        url: href,
        rating,
        reviewCount,
      });
    }

    return out;
  });

  await context.close();

  const dedup = new Map();
  for (const r of rows) {
    const key = `${normalize(r.title)}|${r.sku}`;
    if (!dedup.has(key)) dedup.set(key, r);
    if (dedup.size >= maxItems) break;
  }

  return Array.from(dedup.values()).slice(0, maxItems);
}

async function scrapeHarborFreight(browser, query, maxItems) {
  const searchUrl = `https://www.harborfreight.com/search?q=${encodeURIComponent(query)}`;
  if (!(await robotsAllowed(searchUrl))) return [];

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    const out = [];
    // Harbor Freight uses card-based layout
    const cards = Array.from(document.querySelectorAll('[data-testid="product-card"], .product-tile, [class*="product"]'));

    for (const card of cards) {
      const titleEl = card.querySelector('h3, h4, [data-testid="product-title"], a[aria-label]');
      const priceEl = card.querySelector('[data-testid="price"], .price, [class*="Price"]');
      const linkEl = card.querySelector('a');

      if (!titleEl || !linkEl) continue;

      const title = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || title.length < 8) continue;

      const priceText = (priceEl?.textContent || card.textContent || "");
      const priceMatch = priceText.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
      if (!priceMatch) continue;

      const price = Number(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 0) continue;

      const url = linkEl.href || "";
      const skuMatch = url.match(/-(\d+)\.html/) || url.match(/sku\/(\d+)/i);
      const sku = skuMatch ? skuMatch[1] : "";

      // Extract item number from title or URL
      const itemMatch = title.match(/(?:item\s*|#)\s*(\d{5,7})/i) || url.match(/\/(\d{5,7})/);
      const itemNumber = itemMatch ? itemMatch[1] : sku;

      out.push({
        source: "harborfreight",
        storeName: "Harbor Freight",
        title,
        price,
        sku: itemNumber,
        url: url.startsWith("http") ? url : `https://www.harborfreight.com${url}`,
        rating: null,
        reviewCount: 0,
      });
    }

    return out;
  });

  await context.close();

  const dedup = new Map();
  for (const r of rows) {
    const key = `${normalize(r.title)}|${r.sku}`;
    if (!dedup.has(key)) dedup.set(key, r);
    if (dedup.size >= maxItems) break;
  }

  return Array.from(dedup.values()).slice(0, maxItems);
}

async function scrapeHomeDepot(browser, query, maxItems) {
  // Home Depot has a public search API
  const searchUrl = `https://www.homedepot.com/s/${encodeURIComponent(query)}`;
  if (!(await robotsAllowed(searchUrl))) return [];

  const apiUrl = `https://www.homedepot.com/fprod/suggested-products-api/suggestions?searchTerm=${encodeURIComponent(query)}&storeId=6114&zipCode=${STORE_ZIPS.homedepot}&apiVersion=getProducts_v2`;

  try {
    const response = await fetch(apiUrl, {
      headers: {
        'accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!response.ok) {
      // Fallback to browser scraping
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(3000);

      const rows = await page.evaluate(() => {
        const out = [];
        const products = document.querySelectorAll('[data-testid="product-card"], .pod-product, .product-image');

        for (const prod of products) {
          const titleEl = prod.querySelector('h3, h4, .product-title, [data-testid="product-title"]');
          const priceEl = prod.querySelector('[data-testid="price"], .price, [class*="Price"]');
          const linkEl = prod.querySelector('a');

          if (!titleEl || !linkEl) continue;

          const title = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
          if (!title || title.length < 8) continue;

          const priceText = priceEl?.textContent || prod.closest('.product')?.textContent || "";
          const priceMatch = priceText.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
          if (!priceMatch) continue;

          const price = Number(priceMatch[1]);
          if (!Number.isFinite(price) || price <= 0) continue;

          const url = linkEl.href || "";
          const skuMatch = url.match(/\/(\d{8,11})/) || prod.closest('.product')?.dataset?.itemNumber ? { match: [null, prod.closest('.product').dataset.itemNumber] } : null;
          const sku = skuMatch ? skuMatch[1] : "";

          out.push({
            source: "homedepot",
            storeName: "Home Depot",
            title,
            price,
            sku,
            url: url.startsWith("http") ? url : `https://www.homedepot.com${url}`,
            rating: null,
            reviewCount: 0,
          });
        }

        return out;
      });

      await context.close();

      const dedup = new Map();
      for (const r of rows) {
        const key = `${normalize(r.title)}|${r.sku}`;
        if (!dedup.has(key)) dedup.set(key, r);
        if (dedup.size >= maxItems) break;
      }

      return Array.from(dedup.values()).slice(0, maxItems);
    }

    const data = await response.json();
    const products = [];
    const seen = new Set();

    const extractProducts = (obj) => {
      if (!obj) return;
      walkObjects(obj, (node) => {
        if (node.productId && node.description && node.prices) {
          const key = `${node.productId}`;
          if (seen.has(key)) return;
          seen.add(key);

          const price = cleanPrice(node.prices.primary?.value || node.prices.list?.value);
          if (!Number.isFinite(price) || price <= 0) return;

          products.push({
            source: "homedepot",
            storeName: "Home Depot",
            title: (node.description || "").replace(/\s+/g, " ").trim(),
            price,
            sku: node.productId || "",
            url: node.productDetailsUrl ? `https://www.homedepot.com${node.productDetailsUrl}` : `https://www.homedepot.com/p/-/${node.productId}`,
            rating: node.ratings?.average ? Number(node.ratings.average) : null,
            reviewCount: node.ratings?.count ? Number(node.ratings.count) : 0,
          });
        }
      });
    };

    if (Array.isArray(data.results)) {
      for (const r of data.results) extractProducts(r);
    } else if (data.products) {
      extractProducts(data.products);
    }

    return products.slice(0, maxItems);
  } catch {
    return [];
  }
}

async function scrapeLowes(browser, query, maxItems) {
  const searchUrl = `https://www.lowes.com/search?searchTerm=${encodeURIComponent(query)}`;
  if (!(await robotsAllowed(searchUrl))) return [];

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    const out = [];
    const products = document.querySelectorAll('[data-testid="product-card"], .product-tile, [class*="Product"]');

    for (const prod of products) {
      const titleEl = prod.querySelector('h3, h4, [data-testid="product-name"], .product-title a');
      const priceEl = prod.querySelector('[data-testid="price"], .price, [class*="Price"]');
      const linkEl = prod.querySelector('a');

      if (!titleEl || !linkEl) continue;

      const title = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || title.length < 8) continue;

      const priceText = priceEl?.textContent || prod.textContent || "";
      const priceMatch = priceText.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
      if (!priceMatch) continue;

      const price = Number(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 0) continue;

      const url = linkEl.href || "";
      const skuMatch = url.match(/\/(\d+)\.html/) || prod.dataset?.itemNumber ? { match: [null, prod.dataset.itemNumber] } : null;
      const sku = skuMatch ? skuMatch[1] : "";

      out.push({
        source: "lowes",
        storeName: "Lowe's",
        title,
        price,
        sku,
        url: url.startsWith("http") ? url : `https://www.lowes.com${url}`,
        rating: null,
        reviewCount: 0,
      });
    }

    return out;
  });

  await context.close();

  const dedup = new Map();
  for (const r of rows) {
    const key = `${normalize(r.title)}|${r.sku}`;
    if (!dedup.has(key)) dedup.set(key, r);
    if (dedup.size >= maxItems) break;
  }

  return Array.from(dedup.values()).slice(0, maxItems);
}

async function scrapeDollarGeneral(browser, query, maxItems) {
  const searchUrl = `https://www.dollargeneral.com/search?searchTerm=${encodeURIComponent(query)}`;
  if (!(await robotsAllowed(searchUrl))) return [];

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    const out = [];
    const products = document.querySelectorAll('[data-testid="product-card"], .product-tile, .product-item');

    for (const prod of products) {
      const titleEl = prod.querySelector('h3, h4, .product-title, [data-testid="product-name"]');
      const priceEl = prod.querySelector('.price, [data-testid="price"], [class*="Price"]');
      const linkEl = prod.querySelector('a');

      if (!titleEl || !linkEl) continue;

      const title = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || title.length < 5) continue;

      const priceText = priceEl?.textContent || prod.textContent || "";
      const priceMatch = priceText.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
      if (!priceMatch) continue;

      const price = Number(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 0) continue;

      const url = linkEl.href || "";
      const skuMatch = url.match(/\/(\d+)\.html/) || prod.dataset?.itemNumber ? { match: [null, prod.dataset.itemNumber] } : null;
      const sku = skuMatch ? skuMatch[1] : "";

      out.push({
        source: "dollargeneral",
        storeName: "Dollar General",
        title,
        price,
        sku,
        url: url.startsWith("http") ? url : `https://www.dollargeneral.com${url}`,
        rating: null,
        reviewCount: 0,
      });
    }

    return out;
  });

  await context.close();

  const dedup = new Map();
  for (const r of rows) {
    const key = `${normalize(r.title)}|${r.sku}`;
    if (!dedup.has(key)) dedup.set(key, r);
    if (dedup.size >= maxItems) break;
  }

  return Array.from(dedup.values()).slice(0, maxItems);
}

async function scrapeOllie(browser, query, maxItems) {
  const searchUrl = `https://www.ollies.us/search?query=${encodeURIComponent(query)}`;
  if (!(await robotsAllowed(searchUrl))) return [];

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    const out = [];
    const products = document.querySelectorAll('.product-item, [data-product-id], .product-card');

    for (const prod of products) {
      const titleEl = prod.querySelector('h3, h4, .product-title, a');
      const priceEl = prod.querySelector('.price, .amount, [class*="Price"]');
      const linkEl = prod.querySelector('a');

      if (!titleEl || !linkEl) continue;

      const title = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || title.length < 5) continue;

      const priceText = priceEl?.textContent || prod.textContent || "";
      const priceMatch = priceText.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
      if (!priceMatch) continue;

      const price = Number(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 0) continue;

      const url = linkEl.href || "";
      const skuMatch = url.match(/\/(\d+)\.html/) || prod.dataset?.product?.id ? { match: [null, prod.dataset.product.id] } : null;
      const sku = skuMatch ? skuMatch[1] : "";

      out.push({
        source: "ollie",
        storeName: "Ollie's",
        title,
        price,
        sku,
        url: url.startsWith("http") ? url : `https://www.ollies.us${url}`,
        rating: null,
        reviewCount: 0,
      });
    }

    return out;
  });

  await context.close();

  const dedup = new Map();
  for (const r of rows) {
    const key = `${normalize(r.title)}|${r.sku}`;
    if (!dedup.has(key)) dedup.set(key, r);
    if (dedup.size >= maxItems) break;
  }

  return Array.from(dedup.values()).slice(0, maxItems);
}

async function scrapeFiveBelow(browser, query, maxItems) {
  const searchUrl = `https://www.fivebelow.com/search?query=${encodeURIComponent(query)}`;
  if (!(await robotsAllowed(searchUrl))) return [];

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    const out = [];
    const products = document.querySelectorAll('.product-tile, .product-card, [data-product-id]');

    for (const prod of products) {
      const titleEl = prod.querySelector('h3, h4, .product-title, a');
      const priceEl = prod.querySelector('.price, .amount, [class*="Price"], [data-testid="price"]');
      const linkEl = prod.querySelector('a');

      if (!titleEl || !linkEl) continue;

      const title = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || title.length < 5) continue;

      const priceText = priceEl?.textContent || prod.textContent || "";
      const priceMatch = priceText.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
      if (!priceMatch) continue;

      const price = Number(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 0) continue;

      const url = linkEl.href || "";
      const skuMatch = url.match(/\/(\d+)\.html/) || prod.dataset?.product?.id ? { match: [null, prod.dataset.product.id] } : null;
      const sku = skuMatch ? skuMatch[1] : "";

      out.push({
        source: "fivebelow",
        storeName: "Five Below",
        title,
        price,
        sku,
        url: url.startsWith("http") ? url : `https://www.fivebelow.com${url}`,
        rating: null,
        reviewCount: 0,
      });
    }

    return out;
  });

  await context.close();

  const dedup = new Map();
  for (const r of rows) {
    const key = `${normalize(r.title)}|${r.sku}`;
    if (!dedup.has(key)) dedup.set(key, r);
    if (dedup.size >= maxItems) break;
  }

  return Array.from(dedup.values()).slice(0, maxItems);
}

async function scrapeTJX(browser, query, maxItems) {
  // TJ Maxx/Marshalls/Sierra - they use the same site
  const storeMap = {
    "tjx": { name: "TJ Maxx", url: "https://www.tjmaxx.com" },
    "marshalls": { name: "Marshalls", url: "https://www.marshallsonline.com" },
    "sierra": { name: "Sierra", url: "https://www.sierra.com" },
    "burlington": { name: "Burlington", url: "https://www.burlington.com" },
    "ross": { name: "Ross", url: "https://www.rossstores.com" },
  };

  const results = [];

  for (const [key, store] of Object.entries(storeMap)) {
    const searchUrl = `${store.url}/search?searchTerm=${encodeURIComponent(query)}`;
    if (!(await robotsAllowed(searchUrl))) continue;

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);

      const rows = await page.evaluate(() => {
        const out = [];
        const products = document.querySelectorAll('.product-tile, .product-card, [data-product-id], .product-item');

        for (const prod of products) {
          const titleEl = prod.querySelector('h3, h4, .product-title, a');
          const priceEl = prod.querySelector('.price, .amount, [class*="Price"], [data-testid="price"]');
          const linkEl = prod.querySelector('a');

          if (!titleEl || !linkEl) continue;

          const title = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
          if (!title || title.length < 5) continue;

          const priceText = priceEl?.textContent || prod.textContent || "";
          const priceMatch = priceText.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
          if (!priceMatch) continue;

          const price = Number(priceMatch[1]);
          if (!Number.isFinite(price) || price <= 0) continue;

          const url = linkEl.href || "";
          const sku = prod.dataset?.product?.id || "";

          out.push({
            source: key,
            storeName: store.name,
            title,
            price,
            sku,
            url: url.startsWith("http") ? url : `${store.url}${url}`,
            rating: null,
            reviewCount: 0,
          });
        }

        return out;
      });

      await context.close();
      results.push(...rows.slice(0, Math.ceil(maxItems / 5)));
    } catch {
      continue;
    }
  }

  return results.slice(0, maxItems);
}

async function scrapeHobbyLobby(browser, query, maxItems) {
  const searchUrl = `https://www.hobbylobby.com/search?w=${encodeURIComponent(query)}`;
  if (!(await robotsAllowed(searchUrl))) return [];

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    const out = [];
    const products = document.querySelectorAll('.product-tile, .product-card, [data-product-id]');

    for (const prod of products) {
      const titleEl = prod.querySelector('h3, h4, .product-title, a');
      const priceEl = prod.querySelector('.price, .amount, [class*="Price"], [data-testid="price"]');
      const linkEl = prod.querySelector('a');

      if (!titleEl || !linkEl) continue;

      const title = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || title.length < 5) continue;

      const priceText = priceEl?.textContent || prod.textContent || "";
      const priceMatch = priceText.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
      if (!priceMatch) continue;

      const price = Number(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 0) continue;

      const url = linkEl.href || "";
      const sku = prod.dataset?.product?.id || "";

      out.push({
        source: "hobbylobby",
        storeName: "Hobby Lobby",
        title,
        price,
        sku,
        url: url.startsWith("http") ? url : `https://www.hobbylobby.com${url}`,
        rating: null,
        reviewCount: 0,
      });
    }

    return out;
  });

  await context.close();

  const dedup = new Map();
  for (const r of rows) {
    const key = `${normalize(r.title)}|${r.sku}`;
    if (!dedup.has(key)) dedup.set(key, r);
    if (dedup.size >= maxItems) break;
  }

  return Array.from(dedup.values()).slice(0, maxItems);
}

async function scrapeBigLots(browser, query, maxItems) {
  const searchUrl = `https://www.biglots.com/search?searchTerm=${encodeURIComponent(query)}`;
  if (!(await robotsAllowed(searchUrl))) return [];

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    const out = [];
    const products = document.querySelectorAll('.product-tile, .product-card, [data-product-id]');

    for (const prod of products) {
      const titleEl = prod.querySelector('h3, h4, .product-title, a');
      const priceEl = prod.querySelector('.price, .amount, [class*="Price"], [data-testid="price"]');
      const linkEl = prod.querySelector('a');

      if (!titleEl || !linkEl) continue;

      const title = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || title.length < 5) continue;

      const priceText = priceEl?.textContent || prod.textContent || "";
      const priceMatch = priceText.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
      if (!priceMatch) continue;

      const price = Number(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 0) continue;

      const url = linkEl.href || "";
      const sku = prod.dataset?.product?.id || "";

      out.push({
        source: "biglots",
        storeName: "Big Lots",
        title,
        price,
        sku,
        url: url.startsWith("http") ? url : `https://www.biglots.com${url}`,
        rating: null,
        reviewCount: 0,
      });
    }

    return out;
  });

  await context.close();

  const dedup = new Map();
  for (const r of rows) {
    const key = `${normalize(r.title)}|${r.sku}`;
    if (!dedup.has(key)) dedup.set(key, r);
    if (dedup.size >= maxItems) break;
  }

  return Array.from(dedup.values()).slice(0, maxItems);
}

function walkObjects(root, onObject) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (typeof node === "object") {
      onObject(node);
      for (const v of Object.values(node)) stack.push(v);
    }
  }
}

async function scrapeTarget(_browser, query, maxItems) {
  const searchUrl = `https://www.target.com/s?searchTerm=${encodeURIComponent(query)}`;
  if (!(await robotsAllowed(searchUrl))) return [];

  const params = new URLSearchParams({
    key: "9f36aeafbe60771e321a7cc95a78140772ab3e96",
    platform: "WEB",
    privacy_do_not_sell: "false",
    targeted_advertising_opt_out: "false",
    device_type: "desktop",
    sapphire_channel: "WEB",
    sapphire_page: `/s/${query}`,
    channel: "WEB",
    page: `/s/${query}`,
    visitor_id: "01A01D679838020089C7B17CE5A04FEB",
    purchasable_store_ids: "989,2086,990,2450,2487",
    latitude: "7.140",
    longitude: "125.630",
    scheduled_delivery_store_id: "989",
    scheduled_delivery_zip_code: "43056",
    state: "DAS",
    store_id: "989",
    zip: "08000",
    country: "PH",
    has_pending_inputs: "false",
    count: String(maxItems),
    default_purchasability_filter: "true",
    include_sponsored: "true",
    new_search: "true",
    offset: "0",
    sort_by_option: "relevance",
    spellcheck: "true",
    store_ids: "989,2086,990,2450,2487",
    keyword: query,
    is_seo_bot: "false",
    include_data_source_modules: "true",
    query_string: `searchTerm=${query}`,
    timezone: "Asia/Shanghai",
  });

  const apiUrl = `https://cdui-orchestrations.target.com/cdui_orchestrations/v1/pages/slp?${params.toString()}`;
  const res = await fetch(apiUrl);
  if (!res.ok) return [];
  const payload = await res.json();
  if (!payload) return [];

  const out = [];
  walkObjects(payload, (obj) => {
    const tcin = String(obj.tcin || "");
    if (!tcin) return;

    const title =
      obj?.item?.product_description?.title ||
      obj?.product_description?.title ||
      obj?.title ||
      obj?.name ||
      "";
    if (!title || typeof title !== "string" || title.trim().length < 8) return;

    let price =
      cleanPrice(obj?.price?.current_retail) ||
      cleanPrice(obj?.price?.formatted_current_price) ||
      cleanPrice(obj?.price?.reg_retail) ||
      cleanPrice(obj?.current_retail);
    if (!Number.isFinite(price) || price <= 0) return;

    let rating = null;
    const avg = obj?.ratings_and_reviews?.statistics?.rating?.average;
    if (typeof avg === "number") rating = avg;

    let reviewCount = 0;
    const total = obj?.ratings_and_reviews?.statistics?.rating?.count;
    if (typeof total === "number") reviewCount = total;

    out.push({
      source: "target",
      storeName: "Target",
      title: title.trim(),
      price,
      sku: tcin,
      url: `https://www.target.com/p/-/A-${tcin}`,
      rating,
      reviewCount,
    });
  });

  const dedup = new Map();
  for (const r of out) {
    const key = `${normalize(r.title)}|${r.sku}`;
    if (!dedup.has(key)) dedup.set(key, r);
    if (dedup.size >= maxItems) break;
  }

  return Array.from(dedup.values()).slice(0, maxItems);
}

function extractModelNumber(title) {
  // Look for model numbers like "DCD777D1", "WA5042", "XB100", etc.
  const modelMatch = title.match(/\b([A-Z]{1,2}\d{3,4}[A-Z0-9]*\d[A-Z0-9]*)\b/i);
  return modelMatch ? modelMatch[1].toUpperCase() : null;
}

function extractKeyTerms(title) {
  // Extract key differentiating terms (ignore generic words)
  const generic = new Set([
    "portable", "compact", "professional", "pro", "cordless", "battery", "kit",
    "included", "with", "and", "the", "for", "in", "on", "at", "to", "of", "a",
    "tool", "set", "charger", "case", "black", "white", "red", "blue", "green",
    "yellow", "orange", "silver", "pink", "gray", "grey", "new", "sale", "free",
    "ship", "plus", "max", "pro", "plus", "edition", "special", "limited",
  ]);
  const normalized = normalize(title);
  const tokens = normalized.split(" ").filter(t => t.length > 2 && !generic.has(t));
  return tokens;
}

function toConfidence(similarity, rating, reviewCount, modelMatch) {
  const simScore = Math.min(1, Math.max(0, similarity));
  const ratingScore = rating ? Math.min(1, Math.max(0, rating / 5)) : 0.4;
  const reviewScore = Math.min(1, Math.log10(Math.max(1, Number(reviewCount || 0) + 1)) / 3);
  const modelBonus = modelMatch ? 0.15 : 0;
  return Number((simScore * 0.55 + ratingScore * 0.2 + reviewScore * 0.1 + modelBonus).toFixed(3));
}

function buildCandidates(products, minProfitPct) {
  const out = [];

  for (let i = 0; i < products.length; i += 1) {
    for (let j = 0; j < products.length; j += 1) {
      if (i === j) continue;
      const buy = products[i];
      const comp = products[j];
      if (buy.storeName === comp.storeName) continue;

      const buyBrand = detectBrand(buy.title);
      const compBrand = detectBrand(comp.title);
      if (buyBrand && compBrand && buyBrand !== compBrand) continue;

      if (!buyBrand && buy.title.toLowerCase().includes("speaker") && comp.title.toLowerCase().includes("speaker")) {
        // For electronics without recognized brand, check model number
        const buyModel = extractModelNumber(buy.title);
        const compModel = extractModelNumber(comp.title);
        if (buyModel && compModel && buyModel !== compModel) continue;
      }

      // Extract model numbers and match strictly if present
      const buyModel = extractModelNumber(buy.title);
      const compModel = extractModelNumber(comp.title);
      let modelMatch = false;
      if (buyModel && compModel) {
        // Models must match
        if (buyModel !== compModel) continue;
        modelMatch = true;
      }

      const similarity = tokenSetSimilarity(buy.title, comp.title);
      if (similarity < 0.55) continue; // Increased threshold for better matching

      // Additional check: ensure key terms overlap
      const buyKeys = new Set(extractKeyTerms(buy.title));
      const compKeys = extractKeyTerms(comp.title);
      if (buyKeys.size > 0) {
        let keyOverlap = 0;
        for (const k of compKeys) {
          if (buyKeys.has(k)) keyOverlap += 1;
        }
        const overlapRatio = keyOverlap / Math.max(buyKeys.size, compKeys.length || 1);
        if (overlapRatio < 0.3) continue;
      }

      if (comp.price <= buy.price) continue;

      const profitPct = ((comp.price - buy.price) / buy.price) * 100;
      if (profitPct < minProfitPct) continue;

      out.push({
        title: buy.title,
        buyStore: buy.storeName,
        buyPrice: buy.price,
        buyUrl: buy.url,
        buySku: buy.sku,
        compStore: comp.storeName,
        compPrice: comp.price,
        compUrl: comp.url,
        compSku: comp.sku,
        estimatedProfitPct: Number(profitPct.toFixed(2)),
        similarity: Number(similarity.toFixed(3)),
        confidence: toConfidence(similarity, buy.rating, buy.reviewCount, modelMatch),
      });
    }
  }

  const dedup = new Map();
  for (const row of out) {
    const key = `${normalize(row.title)}|${row.buyStore}|${row.compStore}`;
    const current = dedup.get(key);
    if (!current || row.estimatedProfitPct > current.estimatedProfitPct) {
      dedup.set(key, row);
    }
  }

  return Array.from(dedup.values())
    .filter(r => r.confidence >= 0.45)
    .sort((a, b) => b.estimatedProfitPct - a.estimatedProfitPct);
}

async function run() {
  const args = parseArgs(process.argv);
  const budget = resolveBudgetProfile(args);

  const storesCsv = path.join(process.cwd(), "data", "stores.csv");
  const stores = parseCsv(storesCsv);
  const inRadius = storesWithinRadius(stores, DEFAULT_RADIUS_MILES);

  const cachePath = getCachePath(args.query);
  if (budget.useCache && !args.refresh) {
    const cached = readCache(cachePath, budget.cacheTtlMinutes);
    if (cached) {
      const candidates = Array.isArray(cached.candidates) ? cached.candidates : [];
      console.log(`Query: ${cached.query}`);
      console.log(`Runtime: 0s (cache hit)`);
      console.log(`Products scraped: ${cached.productsScraped}`);
      console.log(`50%+ candidates: ${candidates.length}`);
      console.log(`Budget mode: ${cached.budgetMode || budget.mode}`);
      for (let i = 0; i < Math.min(args.topN, candidates.length); i += 1) {
        const c = candidates[i];
        console.log(
          `${i + 1}. ${c.title} | buy ${c.buyStore} $${c.buyPrice.toFixed(2)} | comp ${c.compStore} $${c.compPrice.toFixed(2)} | profit ${c.estimatedProfitPct.toFixed(1)}% | conf ${c.confidence}`
        );
        console.log(`   buy: ${c.buyUrl}`);
        console.log(`   comp: ${c.compUrl}`);
      }
      if (args.jsonOut) {
        const outPath = path.isAbsolute(args.jsonOut)
          ? args.jsonOut
          : path.join(process.cwd(), args.jsonOut);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(cached, null, 2), "utf8");
        console.log(`Saved report: ${outPath}`);
      }
      return;
    }
  }

  const start = Date.now();
  const browser = await chromium.launch({ headless: !args.headed });

  let products = [];
  if (budget.enableWalmart) {
    products = products.concat(await scrapeWalmart(browser, args.query, budget.maxItemsPerStore));
  }
  if (budget.enableTarget) {
    products = products.concat(await scrapeTarget(browser, args.query, budget.maxItemsPerStore));
  }
  if (budget.enableBestBuy) {
    products = products.concat(await scrapeBestBuy(browser, args.query, budget.maxItemsPerStore));
  }
  if (budget.enableHarborFreight) {
    products = products.concat(await scrapeHarborFreight(browser, args.query, budget.maxItemsPerStore));
  }
  if (budget.enableHomeDepot) {
    products = products.concat(await scrapeHomeDepot(browser, args.query, budget.maxItemsPerStore));
  }
  if (budget.enableLowes) {
    products = products.concat(await scrapeLowes(browser, args.query, budget.maxItemsPerStore));
  }
  if (budget.enableDollarGeneral) {
    products = products.concat(await scrapeDollarGeneral(browser, args.query, budget.maxItemsPerStore));
  }
  if (budget.enableOllie) {
    products = products.concat(await scrapeOllie(browser, args.query, budget.maxItemsPerStore));
  }
  if (budget.enableFiveBelow) {
    products = products.concat(await scrapeFiveBelow(browser, args.query, budget.maxItemsPerStore));
  }
  if (budget.enableTJX) {
    products = products.concat(await scrapeTJX(browser, args.query, budget.maxItemsPerStore));
  }
  if (budget.enableHobbyLobby) {
    products = products.concat(await scrapeHobbyLobby(browser, args.query, budget.maxItemsPerStore));
  }
  if (budget.enableBigLots) {
    products = products.concat(await scrapeBigLots(browser, args.query, budget.maxItemsPerStore));
  }

  await browser.close();

  const candidates = buildCandidates(products, args.minProfitPct);
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(2);

  const report = {
    generatedAt: new Date().toISOString(),
    query: args.query,
    budgetMode: budget.mode,
    creditUsagePct: Number.isFinite(args.creditUsagePct) ? args.creditUsagePct : 0,
    radiusMiles: DEFAULT_RADIUS_MILES,
    storesWithinRadius: inRadius.map((s) => s.name),
    productsScraped: products.length,
    scrapedProducts: products,
    candidateCount: candidates.length,
    candidates,
    runtimeSec: Number(elapsedSec),
    note: "Prices are scraped from public pages and should be manually validated before purchase.",
  };

  console.log(`Query: ${report.query}`);
  console.log(`Runtime: ${report.runtimeSec}s`);
  console.log(`Products scraped: ${report.productsScraped}`);
  console.log(`50%+ candidates: ${report.candidateCount}`);
  console.log(`Budget mode: ${report.budgetMode}`);

  if (report.candidates.length === 0) {
    console.log("No qualifying candidates on this query. Try another term like: tool set, cordless drill, end table.");
  } else {
    for (let i = 0; i < Math.min(args.topN, report.candidates.length); i += 1) {
      const c = report.candidates[i];
      console.log(
        `${i + 1}. ${c.title} | buy ${c.buyStore} $${c.buyPrice.toFixed(2)} | comp ${c.compStore} $${c.compPrice.toFixed(2)} | profit ${c.estimatedProfitPct.toFixed(1)}% | conf ${c.confidence}`
      );
      console.log(`   buy: ${c.buyUrl}`);
      console.log(`   comp: ${c.compUrl}`);
    }
  }

  if (args.jsonOut) {
    const outPath = path.isAbsolute(args.jsonOut)
      ? args.jsonOut
      : path.join(process.cwd(), args.jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`Saved report: ${outPath}`);
  }

  if (budget.useCache) {
    writeCache(cachePath, report);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
