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
          results = await scraper({
            browser,
            query: effectiveQuery,
            maxItemsPerStore:
              budget.maxItemsPerStore,
            clearance:
              args.clearance === true,
            deals:
              args.deals === true,
          });
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

  /*
   * Normal scans keep a small SoldComps shortlist. Challenge/clearance/
   * deals scans need coverage across the scraped inventory, otherwise a
   * good item can be discarded before its sold market is checked.
   */
  const challengeMode =
    args.challenge === true ||
    args.clearance === true ||
    args.deals === true;

  const compProducts = challengeMode
    ? selectProductsForSoldComps(products, products.length)
    : selectProductsForSoldComps(products, 3);

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

  const soldCompBatches = await Promise.all(
    compProducts.map(async (product) => {
      const productQuery = [
        product.title,
        product.model,
      ]
        .filter(Boolean)
        .join(" ");

      if (!productQuery.trim()) {
        return { product, productQuery, comps: [] };
      }

      console.log(
        `[ebay-sold] searching comps for: ${productQuery}`
      );

      try {
        const comps = await scrapeEbaySoldComps(productQuery, 20);
        return { product, productQuery, comps };
      } catch (error) {
        console.warn(
          `[ebay-sold] failed for "${productQuery}": ${error.message || error}`
        );
        return { product, productQuery, comps: [] };
      }
    })
  );

  for (const batch of soldCompBatches) {
    for (const comp of batch.comps) {
      const key =
        comp.url ||
        [comp.title, comp.totalPrice ?? comp.soldPrice ?? comp.price, comp.endedAt ?? comp.soldDate].join("|");

      if (soldCompSeen.has(key)) continue;
      soldCompSeen.add(key);

      soldComps.push({
        ...comp,
        matchedSearchQuery: batch.productQuery,
        matchedSourceProduct: batch.product.title,
        matchedSourceSku: batch.product.sku || null,
        matchedSourceModel: batch.product.model || null,
      });
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
        challengeMode,
        minSales30d: args.minSales30d,
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

    challengeMode,
    minSales30d: args.minSales30d,

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

    hasSoldComps:
      soldComps.length > 0,

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
