/*
 * ============================================================
 * EBAY SOLD COMPS ADAPTER
 * ============================================================
 *
 * Responsibilities:
 *   - Query SoldComps API
 *   - Retrieve recently sold eBay listings
 *   - Normalize SoldComps responses
 *   - Cache duplicate searches during the current run
 *   - Limit API requests during the current run
 *
 * ============================================================
 */

/*
 * ------------------------------------------------------------
 * MODULE STATE
 * ------------------------------------------------------------
 *
 * IMPORTANT:
 * These MUST be outside scrapeEbaySoldComps().
 *
 * Keeping them at module scope means every product searched
 * during one scraper run can reuse the same cache.
 */

const soldCompsCache = new Map();

let soldCompsRequestsThisRun = 0;

/*
 * Your current safety limit.
 *
 * This intentionally leaves a buffer below your daily allowance.
 */
const SOLD_COMPS_MAX_REQUESTS_TODAY = 5;


/*
 * ============================================================
 * MAIN SCRAPER
 * ============================================================
 */

async function scrapeEbaySoldComps(
  query,
  maxItems = 10
) {
  /*
   * ----------------------------------------------------------
   * API KEY
   * ----------------------------------------------------------
   */

  const apiKey =
    process.env.SOLDCOMPS_API_KEY;

  if (!apiKey) {
    console.warn(
      "  [ebay-sold] SOLDCOMPS_API_KEY is missing"
    );

    return [];
  }


  /*
   * ----------------------------------------------------------
   * NORMALIZE QUERY
   * ----------------------------------------------------------
   */

  const normalizedQuery =
    String(query || "")
      .trim()
      .toLowerCase();

  if (!normalizedQuery) {
    console.warn(
      "  [ebay-sold] empty query; skipping"
    );

    return [];
  }


  /*
   * ----------------------------------------------------------
   * CACHE CHECK
   * ----------------------------------------------------------
   *
   * If the same product has already been searched during
   * this run, don't spend another API request.
   */

  if (
    soldCompsCache.has(
      normalizedQuery
    )
  ) {
    console.log(
      `  [ebay-sold] cache hit: ${query}`
    );

    return soldCompsCache.get(
      normalizedQuery
    );
  }


  /*
   * ----------------------------------------------------------
   * REQUEST LIMIT
   * ----------------------------------------------------------
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


  /*
   * Count this request before making it.
   */

  soldCompsRequestsThisRun++;


  console.log(
    `  [ebay-sold] request ` +
    `${soldCompsRequestsThisRun}/` +
    `${SOLD_COMPS_MAX_REQUESTS_TODAY}: ` +
    `${query}`
  );


  /*
   * ----------------------------------------------------------
   * API REQUEST
   * ----------------------------------------------------------
   */

  const params =
    new URLSearchParams({
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


    /*
     * Sold-comps is an external network call. Never let one
     * product search hold the whole scan indefinitely.
     */
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        12000
      );

    let response;

    try {
      response =
        await fetch(url, {
          headers: {
            Authorization:
              `Bearer ${apiKey}`,

            Accept:
              "application/json",
          },

          signal:
            controller.signal,
        });
    } finally {
      clearTimeout(timeout);
    }


    console.log(
      `  [ebay-sold] HTTP status: ${response.status}`
    );


    /*
     * Read the response as text first.
     *
     * This lets us safely diagnose malformed JSON and API
     * error responses.
     */

    const body =
      await response.text();


    /*
     * --------------------------------------------------------
     * HTTP ERROR
     * --------------------------------------------------------
     */

    if (!response.ok) {
      console.error(
        `  [ebay-sold] API error: ` +
        `${body.slice(0, 1000)}`
      );

      /*
       * Cache the empty result so repeated calls for the
       * exact same query don't repeatedly hit a failing API.
       */

      soldCompsCache.set(
        normalizedQuery,
        []
      );

      return [];
    }


    /*
     * --------------------------------------------------------
     * PARSE JSON
     * --------------------------------------------------------
     */

    let data;

    try {
      data =
        JSON.parse(body);
    } catch (error) {
      console.error(
        "  [ebay-sold] API returned invalid JSON"
      );

      console.error(
        `  [ebay-sold] response: ${body.slice(0, 1000)}`
      );

      soldCompsCache.set(
        normalizedQuery,
        []
      );

      return [];
    }


    /*
     * --------------------------------------------------------
     * FIND LISTINGS ARRAY
     * --------------------------------------------------------
     *
     * SoldComps responses can potentially wrap listings in
     * different properties, so support the structures your
     * previous adapter already handled.
     */

    let listings = [];


    if (Array.isArray(data)) {
      listings = data;
    } else if (
      Array.isArray(data.results)
    ) {
      listings = data.results;
    } else if (
      Array.isArray(data.items)
    ) {
      listings = data.items;
    } else if (
      Array.isArray(data.data)
    ) {
      listings = data.data;
    } else if (
      Array.isArray(data.listings)
    ) {
      listings = data.listings;
    }


    console.log(
      `  [ebay-sold] API returned ` +
      `${listings.length} raw listings`
    );


    /*
     * --------------------------------------------------------
     * NORMALIZE RESULTS
     * --------------------------------------------------------
     */

    const results = [];


    for (
      const item of listings
    ) {

      /*
       * Ignore listings that explicitly identify themselves
       * as something other than sold.
       */

      if (
        item.listingType &&
        String(
          item.listingType
        ).toLowerCase() !== "sold"
      ) {
        continue;
      }


      /*
       * ------------------------------------------------------
       * SOLD PRICE
       * ------------------------------------------------------
       */

      const soldPrice =
        Number(
          item.soldPrice ??
          item.price ??
          item.totalPrice
        );


      if (
        !Number.isFinite(
          soldPrice
        ) ||
        soldPrice <= 0
      ) {
        continue;
      }


      /*
       * ------------------------------------------------------
       * SHIPPING
       * ------------------------------------------------------
       */

      const shippingPrice =
        Number(
          item.shippingPrice ?? 0
        );


      /*
       * ------------------------------------------------------
       * TOTAL PRICE
       * ------------------------------------------------------
       */

      const totalPrice =
        Number(
          item.totalPrice ??
          (
            soldPrice +
            shippingPrice
          )
        );


      if (
        !Number.isFinite(
          totalPrice
        ) ||
        totalPrice <= 0
      ) {
        continue;
      }


      /*
       * ------------------------------------------------------
       * NORMALIZED RESULT
       * ------------------------------------------------------
       */

      results.push({

        itemId:
          item.itemId ??
          null,

        url:
          item.url ??
          null,

        thumbnailUrl:
          item.thumbnailUrl ??
          null,

        fullResThumbnailUrl:
          item.fullResThumbnailUrl ??
          null,

        epid:
          item.epid ??
          null,

        title:
          typeof item.title === "string"
            ? item.title.trim()
            : "",

        condition:
          item.condition ??
          null,

        conditionId:
          item.conditionId ??
          null,

        listingType:
          "sold",

        endedAt:
          item.endedAt ??
          null,

        soldPrice,

        soldCurrency:
          item.soldCurrency ??
          "USD",

        shippingPrice,

        shippingCurrency:
          item.shippingCurrency ??
          "USD",

        shippingType:
          item.shippingType ??
          null,

        totalPrice,

        sellerUsername:
          item.sellerUsername ??
          null,

        sellerPositivePercent:
          item.sellerPositivePercent ??
          null,

        sellerFeedbackScore:
          item.sellerFeedbackScore ??
          null,

        itemLocation:
          item.itemLocation ??
          null,

        scrapedAt:
          item.scrapedAt ??
          new Date().toISOString(),
      });


      /*
       * Stop once we have enough usable results.
       */

      if (
        results.length >=
        maxItems
      ) {
        break;
      }
    }


    /*
     * --------------------------------------------------------
     * LOG RESULTS
     * --------------------------------------------------------
     */

    console.log(
      `  [ebay-sold] extracted ` +
      `${results.length} sold comps`
    );


    for (
      const [
        index,
        item,
      ] of results.entries()
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


    /*
     * --------------------------------------------------------
     * SAVE TO CACHE
     * --------------------------------------------------------
     */

    soldCompsCache.set(
      normalizedQuery,
      results
    );


    return results;

  } catch (error) {

    /*
     * --------------------------------------------------------
     * REQUEST FAILURE
     * --------------------------------------------------------
     */

    console.error(
      `  [ebay-sold] failed: ` +
      `${error?.message || error}`
    );


    /*
     * Cache failure as an empty result for this run.
     */

    soldCompsCache.set(
      normalizedQuery,
      []
    );


    return [];
  }
}


/*
 * ============================================================
 * RESET FUNCTION
 * ============================================================
 *
 * This is useful if you ever want to run multiple independent
 * scans inside the same Node process.
 *
 * Your current CLI probably starts a fresh Node process for
 * every `npm run scan`, so it isn't strictly required, but
 * exposing it makes the adapter easier to maintain.
 */

function resetSoldCompsState() {
  soldCompsCache.clear();
  soldCompsRequestsThisRun = 0;
}


/*
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {
  scrapeEbaySoldComps,
  resetSoldCompsState,
};