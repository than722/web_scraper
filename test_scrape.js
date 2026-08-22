const { chromium } = require('playwright');

async function testRetailer(name, url, evaluateFn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(6000);
    const result = await page.evaluate(evaluateFn);
    console.log(`\n=== ${name} ===`);
    console.log('Page title:', result.pageTitle);
    console.log('HTML length:', result.htmlLen);
    console.log('Body text:', (result.bodyText || '').slice(0, 200));
    if (result.productCount) console.log('Product count:', result.productCount);
    if (result.products) console.log('Products:', JSON.stringify(result.products.slice(0, 3), null, 2));
    if (result.nextData) console.log('Next.js data found:', result.nextData);
    if (result.jsonLen) console.log('JSON blob length:', result.jsonLen);
    return result;
  } catch(e) {
    console.log(`\n=== ${name} === ERROR: ${e.message.slice(0, 200)}`);
    return null;
  } finally {
    await page.close();
    await browser.close();
  }
}

(async () => {
  // Walmart
  await testRetailer('Walmart', 'https://www.walmart.com/search?q=drill', () => {
    const nextDataScript = document.querySelector('script#__NEXT_DATA__');
    let nextDataLen = 0;
    if (nextDataScript) {
      try { nextDataLen = JSON.stringify(JSON.parse(nextDataScript.textContent)).length; } catch(e) {}
    }

    // Look for product links
    const links = Array.from(document.querySelectorAll('a[href*="/ip/"]'));
    const productLinks = links.filter(a => a.href.match(/\/ip\/\d/));

    return {
      pageTitle: document.title,
      htmlLen: document.documentElement.innerHTML.length,
      nextData: nextDataLen > 0,
      jsonLen: nextDataLen,
      bodyText: document.body.textContent || '',
      productCount: productLinks.length,
      products: productLinks.slice(0, 5).map(a => {
        const txt = a.getAttribute('aria-label') || a.textContent || '';
        return { href: a.href.replace(/https?:\/\//, ''), title: txt.slice(0, 100) };
      }),
    };
  });

  // Target
  await testRetailer('Target', 'https://www.target.com/s?searchTerm=drill', () => {
    const nextDataScript = document.querySelector('script#__NEXT_DATA__');
    let nextDataLen = 0;
    if (nextDataScript) {
      try { nextDataLen = JSON.stringify(JSON.parse(nextDataScript.textContent)).length; } catch(e) {}
    }
    const links = Array.from(document.querySelectorAll('a[href*="/p/"]'));
    const productLinks = links.filter(a => a.href.match(/target\.com\/p\/\//));
    return {
      pageTitle: document.title,
      htmlLen: document.documentElement.innerHTML.length,
      nextData: nextDataLen > 0,
      jsonLen: nextDataLen,
      bodyText: document.body.textContent || '',
      productCount: productLinks.length,
      products: productLinks.slice(0, 5).map(a => {
        const txt = a.getAttribute('aria-label') || a.textContent || '';
        return { href: a.href.replace(/https?:\/\//, ''), title: txt.slice(0, 100) };
      }),
    };
  });

  // Best Buy for comparison
  const bbResult = await testRetailer('BestBuy', 'https://www.bestbuy.com/site/searchpage.jsp?st=drill&intl=nosplash', () => {
    const links = Array.from(document.querySelectorAll('a[href*="/site/"]'));
    const productLinks = links.filter(a => a.href.includes('/product/') || a.href.includes('/site/'));
    return {
      pageTitle: document.title,
      htmlLen: document.documentElement.innerHTML.length,
      bodyText: document.body.textContent || '',
      productCount: productLinks.length,
      products: productLinks.slice(0, 5).map(a => ({
        href: a.href.replace(/https?:\/\//, ''),
        title: a.textContent?.slice(0, 100) || ''
      })),
    };
  });

  console.log('\n\n=== Comparison Summary ===');
  console.log('Walmart and Target should provide comparison data if product links are found.');
  console.log('Best Buy is the baseline.');

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
