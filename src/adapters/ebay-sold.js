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


module.exports = { scrapeEbaySoldComps };
