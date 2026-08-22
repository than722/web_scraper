const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.target.com/s?searchTerm=drill', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);

  // Check network for API responses
  const apiCalls = [];
  page.on('response', response => {
    const url = response.url();
    if (url.includes('target.com') && (url.includes('search') || url.includes('product') || url.includes('category'))) {
      apiCalls.push({ url, status: response.status() });
    }
  });

  await page.goto('https://www.target.com/s?searchTerm=drill', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);

  console.log('API calls during page load:');
  apiCalls.slice(0, 20).forEach(a => console.log(`  ${a.status} ${a.url}`));

  // Check if products appear after JS hydration
  const productsAfterWait = await page.evaluate(() => {
    // Try Target-specific selectors
    const selectors = [
      '[data-test="@web/SearchProductCard"]',
      '[data-test="product-card"]',
      'a[href*="/p/"]',
      '[data-testid="product-card"]',
    ];
    let found = [];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        found = Array.from(els).slice(0, 5).map(el => {
          const txt = el.textContent || '';
          const priceMatch = txt.match(/\$(\d+\.\d{2})/);
          return {
            selector: sel,
            count: els.length,
            title: txt.slice(0, 100),
            price: priceMatch ? priceMatch[1] : null,
          };
        });
        if (found.length > 0) break;
      }
    }

    // Search body for price strings
    const bodyText = document.body.innerText || '';
    const priceIndices = [...bodyText.matchAll(/\$(\d+\.\d{2})/g)].slice(0, 20);
    const prices = [...new Set(priceIndices.map(m => '$' + m[1]))];

    return {
      foundSelectors: found,
      pricesInBody: prices,
      bodyLen: bodyText.length,
    };
  });

  console.log('\nProducts after JS hydration:');
  console.log(JSON.stringify(productsAfterWait, null, 2));

  // Try clicking to load more or scrolling
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(3000);

  const afterScroll = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/p/"]'));
    const productLinks = links.filter(a => a.href.match(/target\.com\/p\/\//));
    return { productLinkCount: productLinks.length };
  });
  console.log('\nAfter scroll:', JSON.stringify(afterScroll, null, 2));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
