require("dotenv").config();

async function testSoldComps() {
  const apiKey = process.env.SOLDCOMPS_API_KEY;

  if (!apiKey) {
    throw new Error("SOLDCOMPS_API_KEY is missing");
  }

  const params = new URLSearchParams({
    keyword: "Sony XB100",
    ebaySite: "ebay.com",
    page: "1",
    count: "10",
    sortOrder: "endedRecently",
    exactMatch: "true",
  });

  const url = `https://api.sold-comps.com/v1/scrape?${params}`;

  console.log("Calling SoldComps once...");
  console.log("Query: Sony XB100");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  console.log("HTTP status:", response.status);

  const body = await response.text();

  if (!response.ok) {
    console.error("SoldComps error:");
    console.error(body);
    process.exit(1);
  }

  const data = JSON.parse(body);

  console.log("\nSoldComps response:");
  console.log(JSON.stringify(data, null, 2));
}

testSoldComps().catch((error) => {
  console.error("Test failed:", error.message);
  process.exit(1);
});