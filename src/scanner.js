const { attachLocalStoreContext, buildCandidates } = require("./matching");
const { scrapeEbaySoldComps } = require("./adapters/ebay-sold");
const { scrapeBestBuy, scrapeBestBuySpecificUrl } = require("./adapters/bestbuy");

function safeScrape(name, scraper, browser, query, maxItems, failures) {
  console.log(`  🔎 ${name}: scanning...`);
  return scraper(browser, query, maxItems).then(r=>{console.log(`  ✓ ${name}: ${r.length} products`);return r;}).catch(error=>{const message=String(error?.message||error).replace(/\s+/g," ").slice(0,500);console.warn(`  ⚠ ${name}: skipped — ${message}`);failures.push({storeName:name,query,error:message});return [];});
}

function enabledScrapers(budget){return [["Best Buy","bestbuy",budget.enableBestBuy,scrapeBestBuy]].filter(([, , enabled])=>enabled);}

function selectProductsForSoldComps(products,maxProducts=10){
  return products.map(product=>({product,score:(product.isClearance?5:0)+(product.isOpenBox?4:0)+(product.isSale?3:0)+(Number(product.price)>=20?1:0)})).filter(x=>x.product?.title&&Number.isFinite(Number(x.product.price))&&Number(x.product.price)>=10).sort((a,b)=>b.score-a.score).slice(0,maxProducts).map(x=>x.product);
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
  args.clearance === true || args.deals === true
    ? ""
    : String(query || "").trim();

const hasBestBuyUrl =
  Boolean(
    args.bestBuyUrl &&
    args.bestBuyUrl.trim()
  );

if (
      args.clearance !== true &&
      args.deals !== true &&
      !args.bestBuyUrl &&
      !effectiveQuery
    ) {
      throw new Error(
        "A search query, --best-buy-url, --clearance, or --deals is required."
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
     * Clearance/deals discovery currently uses Best Buy's
     * actual clearance/deals inventory pages.
     *
     * Do NOT send an empty search query to other
     * retailers.
     */
    if (
      (args.clearance === true || args.deals === true) &&
      source !== "bestbuy"
    ) {
      continue;
    }

    let results = [];

    try {
      /*
       * Best Buy receives the clearance and deals flags directly.
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
            args.clearance === true,
            args.deals === true
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
      (args.clearance === true || args.deals === true)
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


module.exports = { scanQuery };
