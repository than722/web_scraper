"use strict";

const { chromium } = require("playwright");

const BESTBUY_BASE = "https://www.bestbuy.com";

const CLEARANCE_URL =
  "https://www.bestbuy.com/site/outlet-refurbished-clearance/" +
  "clearance-electronics/pcmcat748300666044.c" +
  "?id=pcmcat748300666044&intl=nosplash";

const DEFAULT_MAX_ITEMS = 20;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

/* =========================================================
 * HELPERS
 * ========================================================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(value) {
  if (!value) return null;

  try {
    return new URL(value, BESTBUY_BASE).href;
  } catch {
    return null;
  }
}

function isBestBuyProductUrl(value) {
  const url = absoluteUrl(value);

  if (!url) return false;

  try {
    const parsed = new URL(url);

    if (!parsed.hostname.includes("bestbuy.com")) {
      return false;
    }

    /*
     * Best Buy product URLs generally contain:
     *
     * /site/product-name/1234567.p
     *
     * Be deliberately permissive about the rest of the URL.
     */
    return /\/site\/[^/?#]+\/\d+\.p(?:$|[?#])/i.test(
      parsed.pathname + parsed.search
    );
  } catch {
    return false;
  }
}

function extractSkuFromUrl(url) {
  if (!url) return null;

  const match = String(url).match(
    /\/(\d+)\.p(?:[?#]|$)/i
  );

  return match ? match[1] : null;
}

function parseMoney(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value)
    .replace(/,/g, "")
    .trim();

  const match = text.match(
    /(?:USD\s*)?\$?\s*(-?\d+(?:\.\d{1,2})?)/
  );

  if (!match) return null;

  const amount = Number(match[1]);

  return Number.isFinite(amount) ? amount : null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = cleanText(value);

    if (text) {
      return text;
    }
  }

  return "";
}

function normalizeTitle(title) {
  return cleanText(title)
    .replace(/\s*\|\s*Best Buy\s*$/i, "")
    .replace(/\s+-\s+Best Buy\s*$/i, "")
    .trim();
}

/* =========================================================
 * INTERNATIONAL / COUNTRY PAGE
 * ========================================================= */

async function isInternationalPage(page) {
  try {
    const title = cleanText(
      await page.title().catch(() => "")
    );

    if (
      /Best Buy International/i.test(title) ||
      /Select your Country/i.test(title) ||
      /Choose a country/i.test(title)
    ) {
      return true;
    }

    const bodyText = cleanText(
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    );

    if (
      /Choose a country/i.test(bodyText) &&
      /United States/i.test(bodyText) &&
      /Canada/i.test(bodyText)
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/*
 * Best Buy's country page has changed several times.
 *
 * The important thing is that ?intl=nosplash now appears
 * to work in your environment, so make that the primary
 * strategy.
 */
async function selectUnitedStates(page, originalUrl) {
  console.log(
    "  [bestbuy] international page detected; attempting to select United States..."
  );

  let success = false;

  /*
   * Strategy 1:
   * Look for a real United States href.
   */
  try {
    const candidates = await page.locator("a").evaluateAll(
      (anchors) =>
        anchors
          .map((a) => ({
            text: cleanText(
              a.innerText || a.textContent || ""
            ),
            href: a.href || "",
            aria: a.getAttribute("aria-label") || "",
            title: a.getAttribute("title") || "",
          }))
          .filter((x) => {
            const combined =
              `${x.text} ${x.aria} ${x.title}`.toLowerCase();

            return (
              combined.includes("united states") ||
              combined.includes("u.s.")
            );
          })
    );

    for (const candidate of candidates) {
      console.log(
        `  [bestbuy] U.S. link candidate: "${candidate.text}" -> ${candidate.href}`
      );
    }

    const usable = candidates.find(
      (x) =>
        x.href &&
        !x.href.startsWith("javascript:")
    );

    if (usable) {
      await page
        .goto(usable.href, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        })
        .catch(() => {});

      await sleep(1500);

      if (!(await isInternationalPage(page))) {
        success = true;
      }
    }
  } catch (error) {
    console.log(
      `  [bestbuy] country-link inspection failed: ${error.message}`
    );
  }

  /*
   * Strategy 2:
   * Click United States text/card.
   */
  if (!success) {
    const selectors = [
      'a:has-text("United States")',
      '[role="link"]:has-text("United States")',
      'button:has-text("United States")',
      'text="United States"',
      '[aria-label*="United States" i]',
      '[title*="United States" i]',
    ];

    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();

        if ((await locator.count()) === 0) {
          continue;
        }

        console.log(
          `  [bestbuy] attempting U.S. click: ${selector}`
        );

        await locator
          .scrollIntoViewIfNeeded()
          .catch(() => {});

        await locator
          .click({
            force: true,
            timeout: 5000,
          })
          .catch(() => {});

        await sleep(2000);

        if (!(await isInternationalPage(page))) {
          success = true;
          break;
        }
      } catch {
        // Try next selector.
      }
    }
  }

  /*
   * Strategy 3:
   * Click the actual element/card containing exactly
   * "United States".
   */
  if (!success) {
    try {
      const clicked = await page.evaluate(() => {
        const elements = Array.from(
          document.querySelectorAll("*")
        );

        const target = elements.find((el) => {
          const text = cleanText(
            el.innerText || el.textContent || ""
          ).toLowerCase();

          if (text !== "united states") {
            return false;
          }

          const rect =
            el.getBoundingClientRect();

          return (
            rect.width > 0 &&
            rect.height > 0
          );
        });

        if (!target) {
          return false;
        }

        let current = target;

        for (let i = 0; i < 7 && current; i++) {
          try {
            current.click();
          } catch {}

          current = current.parentElement;
        }

        return true;
      });

      if (clicked) {
        console.log(
          "  [bestbuy] clicked U.S. country card via DOM fallback"
        );

        await sleep(2500);

        if (!(await isInternationalPage(page))) {
          success = true;
        }
      }
    } catch {
      // Continue.
    }
  }

  /*
   * Strategy 4:
   * Direct ?intl=nosplash.
   */
  if (!success) {
    try {
      const target = new URL(
        originalUrl,
        BESTBUY_BASE
      );

      target.searchParams.set(
        "intl",
        "nosplash"
      );

      console.log(
        `  [bestbuy] direct U.S. navigation fallback: ${target.href}`
      );

      await page
        .goto(target.href, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        })
        .catch(() => {});

      await sleep(2500);

      if (!(await isInternationalPage(page))) {
        success = true;
      }
    } catch (error) {
      console.log(
        `  [bestbuy] direct U.S. navigation failed: ${error.message}`
      );
    }
  }

  if (success) {
    console.log(
      "  [bestbuy] United States selection successful."
    );

    console.log(
      `  [bestbuy] final URL: ${page.url()}`
    );

    console.log(
      `  [bestbuy] final title: ${await page
        .title()
        .catch(() => "")}`
    );

    return true;
  }

  console.log(
    "  [bestbuy] unable to leave international/country-selection page."
  );

  return false;
}

async function ensureUSPage(page, url, label) {
  console.log(
    `  [bestbuy] opening ${label}: ${url}`
  );

  await page
    .goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    })
    .catch((error) => {
      console.log(
        `  [bestbuy] initial navigation warning: ${error.message}`
      );
    });

  await sleep(1500);

  let international =
    await isInternationalPage(page);

  if (international) {
    const selected =
      await selectUnitedStates(
        page,
        url
      );

    international =
      await isInternationalPage(page);

    if (!selected || international) {
      console.log(
        `  [bestbuy] ${label} remains on international page: ${await page
          .title()
          .catch(() => "")}`
      );

      try {
        const direct = new URL(
          url,
          BESTBUY_BASE
        );

        direct.searchParams.set(
          "intl",
          "nosplash"
        );

        await page
          .goto(direct.href, {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          })
          .catch(() => {});

        await sleep(2000);

        international =
          await isInternationalPage(page);
      } catch {}
    }
  }

  if (international) {
    console.log(
      "  [bestbuy] could not get past the international page."
    );

    return false;
  }

  console.log(
    `  [bestbuy] page loaded: ${await page
      .title()
      .catch(() => "")}`
  );

  console.log(
    `  [bestbuy] url: ${page.url()}`
  );

  return true;
}

/* =========================================================
 * INVENTORY LOADING
 * ========================================================= */

async function loadInventory(page, isClearance) {
  await page
    .waitForLoadState("domcontentloaded")
    .catch(() => {});

  await sleep(2000);

  /*
   * Give React/Next/Best Buy time to populate.
   */
  await page
    .waitForTimeout(2500)
    .catch(() => {});

  /*
   * Scroll down progressively.
   */
  for (let i = 0; i < 10; i++) {
    try {
      await page.evaluate(() => {
        window.scrollBy({
          top: Math.max(
            600,
            Math.floor(
              window.innerHeight * 0.9
            )
          ),
          behavior: "instant",
        });
      });
    } catch {}

    await sleep(700);
  }

  /*
   * Scroll all the way down once.
   */
  try {
    await page.evaluate(() => {
      window.scrollTo(
        0,
        document.body.scrollHeight
      );
    });
  } catch {}

  await sleep(1500);

  /*
   * Return to top.
   */
  try {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
  } catch {}

  await sleep(1000);

  /*
   * Extra React hydration time.
   */
  await page
    .waitForTimeout(
      isClearance ? 2500 : 2000
    )
    .catch(() => {});
}

/* =========================================================
 * PRODUCT URL EXTRACTION
 * ========================================================= */

function addProductLink(map, href, source) {
  const url = absoluteUrl(href);

  if (!url) {
    return;
  }

  if (!isBestBuyProductUrl(url)) {
    return;
  }

  const sku = extractSkuFromUrl(url);

  if (!sku) {
    return;
  }

  if (!map.has(sku)) {
    map.set(sku, {
      sku,
      url,
      source,
    });
  }
}

async function collectProductLinks(page) {
  const links = new Map();

  /*
   * =====================================================
   * Strategy 1 — every anchor
   * =====================================================
   */
  try {
    const anchors = await page
      .locator("a[href]")
      .evaluateAll((items) =>
        items.map((a) => a.href || "")
      );

    for (const href of anchors) {
      addProductLink(
        links,
        href,
        "anchor"
      );
    }
  } catch {}

  /*
   * =====================================================
   * Strategy 2 — href/data attributes
   * =====================================================
   */
  try {
    const elements = await page
      .locator(
        "[href], [data-href], [data-url], [data-product-url]"
      )
      .evaluateAll((items) =>
        items.map((el) => ({
          href:
            el.getAttribute("href") ||
            el.getAttribute("data-href") ||
            el.getAttribute("data-url") ||
            el.getAttribute(
              "data-product-url"
            ) ||
            "",
        }))
      );

    for (const item of elements) {
      addProductLink(
        links,
        item.href,
        "attribute"
      );
    }
  } catch {}

  /*
   * =====================================================
   * Strategy 3 — product SKU attributes
   *
   * Best Buy sometimes puts SKU/product IDs directly
   * on cards rather than normal hrefs.
   * =====================================================
   */
  try {
    const skuElements = await page
      .locator(
        [
          "[data-sku-id]",
          "[data-sku]",
          "[data-product-id]",
          "[data-productid]",
          "[data-testid*='product']",
        ].join(",")
      )
      .evaluateAll((items) =>
        items.map((el) => ({
          sku:
            el.getAttribute(
              "data-sku-id"
            ) ||
            el.getAttribute(
              "data-sku"
            ) ||
            el.getAttribute(
              "data-product-id"
            ) ||
            el.getAttribute(
              "data-productid"
            ) ||
            "",
          href:
            el.getAttribute("href") ||
            el.querySelector("a[href]")
              ?.href ||
            "",
        }))
      );

    for (const item of skuElements) {
      if (item.href) {
        addProductLink(
          links,
          item.href,
          "sku-element"
        );
      }

      /*
       * If we have a SKU but no href, construct the
       * product URL only when the SKU is numeric.
       */
      if (
        /^\d+$/.test(
          String(item.sku)
        )
      ) {
        addProductLink(
          links,
          `/site/product/${item.sku}.p`,
          "sku-constructed"
        );
      }
    }
  } catch {}

  /*
   * =====================================================
   * Strategy 4 — HTML source
   * =====================================================
   */
  try {
    const html = await page.content();

    /*
     * Decode common escaped URL forms.
     */
    const normalized = html
      .replace(/\\u002F/gi, "/")
      .replace(/\\\//g, "/")
      .replace(/&quot;/gi, '"')
      .replace(/&#x2F;/gi, "/")
      .replace(/&amp;/gi, "&");

    /*
     * Find ANY Best Buy /site/.../1234567.p URL.
     */
    const regex =
      /(?:https?:\/\/(?:www\.)?bestbuy\.com)?(\/site\/[^"'\\\s<>]+\/\d+\.p(?:\?[^"'\\\s<>]*)?)/gi;

    let match;

    while (
      (match = regex.exec(normalized)) !== null
    ) {
      addProductLink(
        links,
        match[0],
        "html"
      );

      addProductLink(
        links,
        match[1],
        "html"
      );
    }
  } catch {}

  /*
   * =====================================================
   * Strategy 5 — look for JSON/serialized product IDs
   * =====================================================
   */
  try {
    const html = await page.content();

    const skuRegex =
      /(?:skuId|sku|productId|productID|itemId)["'\s:=]+["']?(\d{5,12})/gi;

    let match;

    while (
      (match = skuRegex.exec(html)) !== null
    ) {
      const sku = match[1];

      /*
       * Only add if we don't already have the SKU.
       *
       * Constructing a generic Best Buy URL is a fallback;
       * product-page extraction will verify it.
       */
      if (!links.has(sku)) {
        links.set(sku, {
          sku,
          url: `${BESTBUY_BASE}/site/product/${sku}.p`,
          source: "serialized-sku",
        });
      }
    }
  } catch {}

  return Array.from(links.values());
}

/* =========================================================
 * PRICE
 * ========================================================= */

function findPriceInText(text) {
  const clean = cleanText(text);

  if (!clean) {
    return null;
  }

  const matches = [
    ...clean.matchAll(
      /\$\s*([0-9]{1,5}(?:,\d{3})*(?:\.\d{2})?)/g
    ),
  ];

  const prices = matches
    .map((m) => parseMoney(m[0]))
    .filter(
      (value) =>
        Number.isFinite(value) &&
        value > 0 &&
        value < 100000
    );

  if (prices.length === 0) {
    return null;
  }

  return prices[0];
}

/* =========================================================
 * LISTING CARD EXTRACTION
 * ========================================================= */

async function extractListingCardData(
  page,
  productLinks
) {
  const output = [];

  const linkBySku = new Map();

  for (const item of productLinks) {
    if (item.sku) {
      linkBySku.set(
        item.sku,
        item.url
      );
    }
  }

  /*
   * Broad card selectors.
   */
  try {
    const cards = await page
      .locator(
        [
          '[data-testid*="product"]',
          '[data-automation*="product"]',
          '[class*="product-card"]',
          '[class*="productCard"]',
          '[class*="sku-item"]',
          '[class*="productList"] li',
          '[class*="product-list"] li',
          'li[class*="product"]',
          'article',
        ].join(",")
      )
      .evaluateAll((elements) =>
        elements.map((el) => {
          const text =
            el.innerText ||
            el.textContent ||
            "";

          const anchors = Array.from(
            el.querySelectorAll(
              "a[href]"
            )
          ).map((a) => ({
            href: a.href || "",
            text:
              a.innerText ||
              a.textContent ||
              "",
          }));

          const images = Array.from(
            el.querySelectorAll("img")
          ).map((img) => ({
            alt: img.alt || "",
            src:
              img.currentSrc ||
              img.src ||
              "",
          }));

          const sku =
            el.getAttribute(
              "data-sku-id"
            ) ||
            el.getAttribute(
              "data-sku"
            ) ||
            el.getAttribute(
              "data-product-id"
            ) ||
            "";

          return {
            text,
            anchors,
            images,
            sku,
          };
        })
      );

    for (const card of cards) {
      const text = cleanText(
        card.text
      );

      if (!text) continue;

      let url = null;
      let sku = null;

      /*
       * First find a product anchor.
       */
      for (const anchor of card.anchors) {
        if (
          isBestBuyProductUrl(
            anchor.href
          )
        ) {
          url = absoluteUrl(
            anchor.href
          );

          sku =
            extractSkuFromUrl(
              url
            );

          break;
        }
      }

      /*
       * If no anchor, use data SKU.
       */
      if (
        !url &&
        /^\d+$/.test(
          String(card.sku)
        )
      ) {
        sku = String(card.sku);

        url =
          linkBySku.get(sku) ||
          `${BESTBUY_BASE}/site/product/${sku}.p`;
      }

      if (!url || !sku) {
        continue;
      }

      const title =
        firstNonEmpty(
          ...card.anchors
            .map((a) => a.text)
            .filter(Boolean)
        );

      const price =
        findPriceInText(text);

      const image =
        card.images.length > 0
          ? card.images[0].src
          : null;

      if (
        title &&
        Number.isFinite(price)
      ) {
        output.push({
          sku,
          url,
          title:
            normalizeTitle(title),
          price,
          imageUrl: image,
        });
      }
    }
  } catch {}

  /*
   * Direct anchor fallback.
   */
  try {
    const raw = await page
      .locator("a[href]")
      .evaluateAll((anchors) =>
        anchors
          .map((a) => {
            const href =
              a.href || "";

            if (
              !/\/site\/[^/?#]+\/\d+\.p/i.test(
                href
              )
            ) {
              return null;
            }

            const parent =
              a.closest(
                "article, li, [data-testid], div"
              );

            return {
              href,
              anchorText:
                a.innerText ||
                a.textContent ||
                "",
              parentText:
                parent?.innerText ||
                parent?.textContent ||
                "",
            };
          })
          .filter(Boolean)
      );

    for (const item of raw) {
      const url =
        absoluteUrl(
          item.href
        );

      const sku =
        extractSkuFromUrl(
          url
        );

      if (!sku) continue;

      if (
        output.some(
          (x) => x.sku === sku
        )
      ) {
        continue;
      }

      const combined =
        cleanText(
          `${item.anchorText} ${item.parentText}`
        );

      const price =
        findPriceInText(
          combined
        );

      const title =
        normalizeTitle(
          firstNonEmpty(
            item.anchorText
          )
        );

      if (
        title &&
        Number.isFinite(price)
      ) {
        output.push({
          sku,
          url,
          title,
          price,
          imageUrl: null,
        });
      }
    }
  } catch {}

  return output;
}

/* =========================================================
 * PRODUCT PAGE EXTRACTION
 * ========================================================= */

async function extractProductPageData(
  page,
  link
) {
  /*
   * JSON-LD.
   */
  try {
    const jsonLd =
      await page
        .locator(
          'script[type="application/ld+json"]'
        )
        .evaluateAll((scripts) =>
          scripts
            .map((script) => {
              try {
                return JSON.parse(
                  script.textContent ||
                    ""
                );
              } catch {
                return null;
              }
            })
            .filter(Boolean)
        );

    for (const data of jsonLd) {
      const candidates =
        Array.isArray(data)
          ? data
          : [data];

      for (const item of candidates) {
        if (!item) continue;

        let product = null;

        if (
          item["@type"] ===
          "Product"
        ) {
          product = item;
        } else if (
          Array.isArray(
            item["@graph"]
          )
        ) {
          product =
            item["@graph"].find(
              (x) =>
                x &&
                x["@type"] ===
                  "Product"
            );
        }

        if (!product) continue;

        const offers =
          Array.isArray(
            product.offers
          )
            ? product.offers[0]
            : product.offers;

        const price =
          parseMoney(
            offers?.price ??
              offers?.lowPrice
          );

        if (
          product.name &&
          Number.isFinite(price)
        ) {
          return {
            sku:
              link.sku ||
              extractSkuFromUrl(
                link.url
              ),
            url: link.url,
            title:
              normalizeTitle(
                product.name
              ),
            price,
            imageUrl:
              Array.isArray(
                product.image
              )
                ? product.image[0]
                : product.image ||
                  null,
          };
        }
      }
    }
  } catch {}

  /*
   * DOM fallback.
   */
  try {
    const title =
      firstNonEmpty(
        await page
          .locator("h1")
          .first()
          .innerText()
          .catch(() => ""),

        await page
          .locator(
            '[data-testid*="product-title"]'
          )
          .first()
          .innerText()
          .catch(() => ""),

        await page.title().catch(
          () => ""
        )
      );

    const bodyText =
      await page
        .locator("body")
        .innerText()
        .catch(() => "");

    const price =
      findPriceInText(
        bodyText
      );

    const image =
      await page
        .locator("img")
        .first()
        .getAttribute("src")
        .catch(() => null);

    if (
      title &&
      Number.isFinite(price)
    ) {
      return {
        sku:
          link.sku ||
          extractSkuFromUrl(
            link.url
          ),
        url: link.url,
        title:
          normalizeTitle(title),
        price,
        imageUrl: image,
      };
    }
  } catch {}

  return null;
}

/* =========================================================
 * NORMALIZE
 * ========================================================= */

function normalizeProduct(
  item,
  isClearance
) {
  const url =
    absoluteUrl(item.url);

  const sku =
    item.sku ||
    extractSkuFromUrl(url);

  return {
    retailer: "bestbuy",
    source: "bestbuy",

    title:
      normalizeTitle(
        item.title
      ),

    name:
      normalizeTitle(
        item.title
      ),

    price:
      Number(item.price),

    currentPrice:
      Number(item.price),

    url,
    productUrl: url,

    sku:
      sku || null,

    modelNumber:
      item.modelNumber ||
      null,

    imageUrl:
      item.imageUrl ||
      item.image ||
      null,

    clearance:
      Boolean(isClearance),

    isClearance:
      Boolean(isClearance),

    deal:
      Boolean(
        isClearance ||
        item.deal ||
        item.sale
      ),

    sale:
      Boolean(
        item.sale ||
        isClearance
      ),

    sourceType:
      isClearance
        ? "clearance"
        : "search",

    scrapedAt:
      new Date().toISOString(),
  };
}

function uniqueProducts(products) {
  const seen = new Set();
  const output = [];

  for (const product of products) {
    const key =
      product.sku ||
      product.url ||
      product.title;

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(product);
  }

  return output;
}

/* =========================================================
 * CREATE BROWSER
 * ========================================================= */

async function createPage() {
  const browser =
    await chromium.launch({
      headless: true,
    });

  const context =
    await browser.newContext({
      userAgent: USER_AGENT,

      viewport: {
        width: 1440,
        height: 1000,
      },

      locale: "en-US",

      timezoneId:
        "America/Chicago",

      colorScheme: "light",

      extraHTTPHeaders: {
        "Accept-Language":
          "en-US,en;q=0.9",
      },
    });

  const page =
    await context.newPage();

  /*
   * Only block fonts/media.
   *
   * DO NOT block JS, CSS, XHR, fetch, images,
   * because Best Buy needs those for inventory.
   */
  await page.route(
    "**/*",
    async (route) => {
      const type =
        route.request()
          .resourceType();

      if (
        type === "font" ||
        type === "media"
      ) {
        await route
          .abort()
          .catch(() => {});

        return;
      }

      await route
        .continue()
        .catch(() => {});
    }
  );

  return {
    browser,
    context,
    page,
  };
}

/* =========================================================
 * MAIN SCRAPER
 * ========================================================= */

async function scrapeBestBuy(
  queryOrOptions,
  maxItemsArg,
  maybeOptions
) {
  let query = "";
  let maxItems =
    DEFAULT_MAX_ITEMS;
  let options = {};

  /*
   * Object form.
   */
  if (
    queryOrOptions &&
    typeof queryOrOptions ===
      "object" &&
    !Array.isArray(
      queryOrOptions
    )
  ) {
    options = queryOrOptions;

    /*
     * Accept MANY possible property names.
     */
    query =
      options.query ??
      options.search ??
      options.searchQuery ??
      options.term ??
      options.keyword ??
      options.q ??
      "";

    maxItems =
      Number(
        options.maxItemsPerStore ??
          options.maxItems ??
          options.limit ??
          options.max ??
          DEFAULT_MAX_ITEMS
      );
  } else {
    /*
     * String form.
     */
    query =
      String(
        queryOrOptions || ""
      );

    if (
      maxItemsArg &&
      typeof maxItemsArg ===
        "object"
    ) {
      options =
        maxItemsArg;

      maxItems =
        Number(
          options.maxItemsPerStore ??
            options.maxItems ??
            options.limit ??
            DEFAULT_MAX_ITEMS
        );
    } else {
      maxItems =
        Number(
          maxItemsArg ??
            DEFAULT_MAX_ITEMS
        );

      if (
        maybeOptions &&
        typeof maybeOptions ===
          "object"
      ) {
        options =
          maybeOptions;
      }
    }
  }

  /*
   * Also support query nested inside options.
   */
  if (!query && options) {
    query =
      options.query ??
      options.search ??
      options.searchQuery ??
      options.term ??
      options.keyword ??
      options.q ??
      "";
  }

  query =
    String(query ?? "").trim();

  if (
    !Number.isFinite(maxItems) ||
    maxItems <= 0
  ) {
    maxItems =
      DEFAULT_MAX_ITEMS;
  }

  maxItems = Math.min(
    Math.floor(maxItems),
    100
  );

  const clearance =
    Boolean(
      options.clearance ||
        options.isClearance ||
        options.mode ===
          "clearance"
    );

  /*
   * Build URL.
   */
  let url;

  if (clearance) {
    url = CLEARANCE_URL;
  } else {
    const encoded =
      encodeURIComponent(query);

    url =
      `${BESTBUY_BASE}/site/searchpage.jsp` +
      `?st=${encoded}` +
      `&intl=nosplash`;
  }

  const label =
    clearance
      ? "clearance"
      : `search: "${query}"`;

  let browser;
  let context;
  let page;

  try {
    ({
      browser,
      context,
      page,
    } = await createPage());

    console.log(
      `  [bestbuy] opening ${label}: ${url}`
    );

    const ok =
      await ensureUSPage(
        page,
        url,
        label
      );

    if (!ok) {
      return [];
    }

    /*
     * Load inventory.
     */
    await loadInventory(
      page,
      clearance
    );

    /*
     * If somehow returned to country page,
     * recover.
     */
    if (
      await isInternationalPage(
        page
      )
    ) {
      console.log(
        "  [bestbuy] page returned to international page after loading."
      );

      const recovered =
        await selectUnitedStates(
          page,
          url
        );

      if (!recovered) {
        return [];
      }

      await loadInventory(
        page,
        clearance
      );
    }

    /*
     * =====================================================
     * PRODUCT LINKS
     * =====================================================
     */

    let productLinks =
      await collectProductLinks(
        page
      );

    console.log(
      `  [bestbuy] product links: ${productLinks.length}`
    );

    /*
     * Useful diagnostic if Best Buy changes again.
     */
    if (
      productLinks.length === 0
    ) {
      try {
        const bodyText =
          cleanText(
            await page
              .locator("body")
              .innerText()
              .catch(() => "")
          );

        console.log(
          `  [bestbuy] page body characters: ${bodyText.length}`
        );

        console.log(
          `  [bestbuy] page contains "drill": ${bodyText
            .toLowerCase()
            .includes(
              "drill"
            )}`
        );

        console.log(
          `  [bestbuy] page contains "$": ${bodyText.includes(
            "$"
          )}`
        );
      } catch {}
    }

    /*
     * Second hydration attempt.
     */
    if (
      productLinks.length === 0
    ) {
      console.log(
        "  [bestbuy] no product links yet; waiting for inventory hydration..."
      );

      await sleep(3000);

      await loadInventory(
        page,
        clearance
      );

      productLinks =
        await collectProductLinks(
          page
        );

      console.log(
        `  [bestbuy] product links after hydration: ${productLinks.length}`
      );
    }

    /*
     * Third attempt:
     * reload the actual URL once.
     *
     * This helps when the first React render didn't
     * populate the product grid.
     */
    if (
      productLinks.length === 0
    ) {
      console.log(
        "  [bestbuy] still no product links; performing one fresh page reload..."
      );

      await page
        .reload({
          waitUntil:
            "domcontentloaded",
          timeout: 45000,
        })
        .catch(() => {});

      await sleep(3000);

      await loadInventory(
        page,
        clearance
      );

      productLinks =
        await collectProductLinks(
          page
        );

      console.log(
        `  [bestbuy] product links after reload: ${productLinks.length}`
      );
    }

    /*
     * Final HTML diagnostics.
     */
    if (
      productLinks.length === 0
    ) {
      try {
        const html =
          await page.content();

        console.log(
          `  [bestbuy] final HTML characters: ${html.length}`
        );

        console.log(
          `  [bestbuy] HTML contains ".p": ${html.includes(
            ".p"
          )}`
        );

        console.log(
          `  [bestbuy] HTML contains "sku": ${html
            .toLowerCase()
            .includes(
              "sku"
            )}`
        );
      } catch {}
    }

    console.log(
      `  [bestbuy] final product links: ${productLinks.length}`
    );

    /*
     * =====================================================
     * EXTRACT PRODUCTS
     * =====================================================
     */

    const products =
      await extractProductsFromPage(
        page,
        productLinks,
        maxItems,
        clearance
      );

    console.log(
      `  [bestbuy] "${clearance ? "clearance" : query}" extracted ${products.length} raw products`
    );

    const unique =
      uniqueProducts(
        products
      ).slice(
        0,
        maxItems
      );

    console.log(
      `  [bestbuy] extracted ${unique.length} unique products`
    );

    for (
      const [
        index,
        product,
      ] of unique.entries()
    ) {
      console.log(
        `  [bestbuy] #${index + 1} ` +
          `${product.title} | ` +
          `$${Number(
            product.price
          ).toFixed(2)}` +
          `${
            product.sku
              ? ` | SKU: ${product.sku}`
              : ""
          }` +
          `${
            product.clearance
              ? " | CLEARANCE"
              : ""
          }`
      );
    }

    return unique;
  } catch (error) {
    console.error(
      `  [bestbuy] scrape failed: ${error.message}`
    );

    return [];
  } finally {
    if (context) {
      await context
        .close()
        .catch(() => {});
    }

    if (browser) {
      await browser
        .close()
        .catch(() => {});
    }
  }
}

/* =========================================================
 * PRODUCT EXTRACTION DRIVER
 * ========================================================= */

async function extractProductsFromPage(
  page,
  productLinks,
  maxItems,
  isClearance
) {
  const products = [];

  /*
   * First use listing cards.
   */
  const cardData =
    await extractListingCardData(
      page,
      productLinks
    );

  for (const item of cardData) {
    if (
      item &&
      item.url &&
      item.title &&
      Number.isFinite(
        item.price
      )
    ) {
      products.push(
        normalizeProduct(
          item,
          isClearance
        )
      );
    }
  }

  const seen = new Set(
    products.map(
      (item) =>
        item.sku ||
        item.url
    )
  );

  if (
    products.length >=
    maxItems
  ) {
    return uniqueProducts(
      products
    ).slice(
      0,
      maxItems
    );
  }

  /*
   * Product page fallback.
   */
  let linksToVisit =
    productLinks.slice(
      0,
      Math.max(
        maxItems * 3,
        maxItems
      )
    );

  for (const link of linksToVisit) {
    if (
      products.length >=
      maxItems
    ) {
      break;
    }

    const key =
      link.sku ||
      extractSkuFromUrl(
        link.url
      ) ||
      link.url;

    if (seen.has(key)) {
      continue;
    }

    try {
      const productPage =
        await page
          .context()
          .newPage();

      await productPage
        .goto(link.url, {
          waitUntil:
            "domcontentloaded",
          timeout: 30000,
        })
        .catch(() => {});

      await productPage
        .waitForTimeout(1200)
        .catch(() => {});

      const product =
        await extractProductPageData(
          productPage,
          link
        );

      await productPage
        .close()
        .catch(() => {});

      if (
        product &&
        product.title &&
        Number.isFinite(
          product.price
        )
      ) {
        const normalized =
          normalizeProduct(
            product,
            isClearance
          );

        const normalizedKey =
          normalized.sku ||
          normalized.url;

        if (
          !seen.has(
            normalizedKey
          )
        ) {
          seen.add(
            normalizedKey
          );

          products.push(
            normalized
          );
        }
      }
    } catch (error) {
      console.log(
        `  [bestbuy] product-page fallback failed for ${link.url}: ${error.message}`
      );
    }
  }

  return uniqueProducts(
    products
  ).slice(
    0,
    maxItems
  );
}

/* =========================================================
 * CONVENIENCE FUNCTIONS
 * ========================================================= */

async function scrapeBestBuySearch(
  query,
  maxItems = DEFAULT_MAX_ITEMS,
  options = {}
) {
  return scrapeBestBuy(
    {
      ...options,
      query,
      maxItems,
      clearance: false,
    }
  );
}

async function scrapeBestBuyClearance(
  maxItems = DEFAULT_MAX_ITEMS,
  options = {}
) {
  return scrapeBestBuy({
    ...options,
    query: "clearance",
    maxItems,
    clearance: true,
  });
}

async function scrape(
  queryOrOptions,
  maxItems,
  options
) {
  return scrapeBestBuy(
    queryOrOptions,
    maxItems,
    options
  );
}

/* =========================================================
 * EXPORTS
 * ========================================================= */

module.exports =
  scrapeBestBuy;

module.exports.scrapeBestBuy =
  scrapeBestBuy;

module.exports.scrapeBestBuySearch =
  scrapeBestBuySearch;

module.exports.scrapeBestBuyClearance =
  scrapeBestBuyClearance;

module.exports.scrape =
  scrape;

module.exports.BESTBUY_BASE =
  BESTBUY_BASE;

module.exports.CLEARANCE_URL =
  CLEARANCE_URL;