const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.target.com/s?searchTerm=drill', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const result = await page.evaluate(() => {
    const nextDataScript = document.querySelector('script#__NEXT_DATA__');
    if (!nextDataScript) return { error: 'no next data' };

    let payload;
    try { payload = JSON.parse(nextDataScript.textContent); } catch(e) { return { error: 'parse fail' }; }

    function findProductArrays(obj, path, results, depth = 0) {
      if (depth > 8) return;
      if (Array.isArray(obj)) {
        if (obj.length > 0 && obj[0]?.tcin) {
          results.push({
            path,
            count: obj.length,
            sample: obj.slice(0, 2).map(x => ({
              tcin: x.tcin,
              title: (x.title || x.name || '').slice(0, 60),
              price: x.price?.current?.price || x.price?.current_retail || null,
              url: x.productUrl || x.url || '',
            }))
          });
        }
        for (const item of obj) findProductArrays(item, path, results, depth + 1);
      } else if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          findProductArrays(v, path + '.' + k, results, depth + 1);
        }
      }
    }

    const arrays = [];
    findProductArrays(payload, '', arrays);

    return {
      arraysFound: arrays.length,
      products: arrays.map(a => ({ path: a.path, count: a.count, sample: a.sample })),
      topKeys: Object.keys(payload).slice(0, 10),
    };
  });

  console.log('Target Next.js data analysis:');
  console.log('Top keys:', result.topKeys);
  console.log('Arrays with tcin:', result.arraysFound);
  console.log(JSON.stringify(result.products, null, 2));

  // Check raw body for price patterns
  const bodyText = await page.evaluate(() => document.body.innerText || '');
  const priceRegex = /\$(\d+\.\d{2})/g;
  const priceMatches = [...new Set(bodyText.match(priceRegex) || [])];
  console.log('\nPrice patterns found in body:', priceMatches.slice(0, 20));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
