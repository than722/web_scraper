const { chromium } = require('playwright');

async function testRetailer(name, url, waitForMs = 5000) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(waitForMs);

    const result = await page.evaluate(() => {
      const nextDataScript = document.querySelector('script#__NEXT_DATA__');
      let nextData = null;
      if (nextDataScript) {
        try { nextData = JSON.parse(nextDataScript.textContent); } catch(e) {}
      }

      const bodyText = document.body.innerText || '';
      const priceRegex = /\$(\d+(?:\.\d{2})?)/g;
      const prices = [...new Set([...bodyText.matchAll(priceRegex)].map(m => '$' + m[1]))];

      // Look for product card elements
      const productSelectors = [
        'a[href*="/p/"]',
        'a[href*="/ip/"]',
        '[data-testid*="product"]',
        '.product-card',
        '[data-qa*="product"]',
      ];
      let productLinkCount = 0;
      const linkSets = {};
      for (const sel of productSelectors) {
        const links = document.querySelectorAll(sel);
        linkSets[sel] = links.length;
        if (links.length > productLinkCount) productLinkCount = links.length;
      }

      return {
        pageTitle: document.title,
        htmlLen: document.documentElement.innerHTML.length,
        bodyLen: bodyText.length,
        nextData: nextData ? `found (${JSON.stringify(nextData).length} bytes)` : 'not found',
        prices: prices.slice(0, 15),
        productLinkCount,
        linkSets,
      };
    });

    const blocked = result.htmlLen < 2000 || result.pageTitle.includes('Robot') || result.pageTitle.includes('Access denied');
    console.log(`${name}: ${blocked ? 'BLOCKED' : 'OK'} | HTTP ${resp.status()} | HTML ${result.htmlLen} | Products ${result.productLinkCount} | Prices ${result.prices.length} | NextData ${result.nextData}`);
    if (!blocked && result.prices.length > 0) {
      console.log(`  Prices: ${result.prices.join(', ')}`);
    }
    if (!blocked && result.productLinkCount > 0) {
      console.log(`  Link sets: ${JSON.stringify(result.linkSets)}`);
    }
  } catch(e) {
    console.log(`${name}: ERROR - ${e.message.slice(0, 150)}`);
  } finally {
    await browser.close();
  }
}

(async () => {
  const retailers = [
    ['Target', 'https://www.target.com/s?searchTerm=drill'],
    ['Harbor Freight', 'https://www.harborfreight.com/search?q=drill'],
    ['Northern Tool', 'https://www.northerntool.com/search?q=drill'],
    ['Menards', 'https://www.menards.com/main/search.html?search=drill'],
    ['Home Depot', 'https://www.homedepot.com/s/drill'],
    ['Lowes', 'https://www.lowes.com/pl/drills-drill-bits-Power-Tool-Accessories-Tools-Hardware/4294754129'],
    ['Ace Hardware', 'https://www.acehardware.com/?q=drill'],
    ['True Value', 'https://www.truevalue.com/search?query=drill'],
    ['Acme Tools', 'https://www.acmetools.com/search?q=drill'],
    ['Blain FarmFleet', 'https://www.farmandfleet.com/search/?q=drill'],
    ['DoItBest', 'https://www.doitbest.com/search?q=drill'],
    ['Big Lots', 'https://www.biglots.com/search?q=drill'],
  ];

  console.log('=== Testing retailer accessibility ===\n');
  for (const [name, url] of retailers) {
    await testRetailer(name, url);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
