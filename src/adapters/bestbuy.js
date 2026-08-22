const { robotsAllowed, debugSnapshot } = require("../config");

const BESTBUY_SEARCH = "https://www.bestbuy.com/site/searchpage.jsp?st=";
const BESTBUY_CLEARANCE = "https://www.bestbuy.com/site/outlet-refurbished-clearance/clearance-electronics/pcmcat748300666044.c?id=pcmcat748300666044";
const BESTBUY_TOP_DEALS = "https://www.bestbuy.com/top-deals";
const BESTBUY_DEAL_OF_DAY = "https://www.bestbuy.com/site/misc/deal-of-the-day/pcmcat248000050016.c?id=pcmcat248000050016";

function isInternational(title, url) {
  return String(url).toLowerCase().includes("international") || String(title).toLowerCase().includes("select your country");
}

async function extractProductCards(page, { requireDealSignal=false, forcedDealType=null, maxRaw=200 }={}) {
  return page.evaluate(({requireDealSignal,forcedDealType,maxRaw})=>{
    const clean=s=>String(s||"").replace(/\s+/g," ").trim();
    const money=/\$\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/g;
    const links=Array.from(document.querySelectorAll('a[href*="/site/"],a[href*="/product/"]'));
    const seen=new Set(),out=[];
    for(const a of links){
      if(out.length>=maxRaw)break;
      const href=a.href||"";
      const m=href.match(/\/(\d{6,})\.p(?:[?#]|$)/i)||href.match(/\/product\/[^/]+\/(\d{6,})(?:\/|[?#]|$)/i);
      if(!m)continue;
      const sku=m[1]; if(seen.has(sku))continue; seen.add(sku);
      let node=a,cardText="";
      for(let depth=0;depth<10&&node;depth++,node=node.parentElement){const t=clean(node.textContent);if(/\$\s*[0-9]/.test(t)){cardText=t;break;}}
      if(!cardText)cardText=clean(a.parentElement?.textContent);
      const title=clean(a.textContent); if(!title||title.length<8)continue;
      const prices=[...cardText.matchAll(money)].map(x=>Number(x[1].replace(/,/g,""))).filter(n=>Number.isFinite(n)&&n>0&&n<100000);
      if(!prices.length)continue;
      const lower=cardText.toLowerCase();
      const isClearance=lower.includes("clearance");
      const isOpenBox=lower.includes("open-box")||lower.includes("open box");
      const isSale=lower.includes("deal")||lower.includes("sale")||lower.includes("discount")||lower.includes("save $")||lower.includes("price was");
      const savingsMatch=cardText.match(/save\s*\$\s*([0-9,.]+)/i);
      const compMatch=cardText.match(/(?:comp(?:arable)?\s*value|price was|was)\s*[:]?\s*\$\s*([0-9,.]+)/i);
      if(requireDealSignal && !(isClearance||isOpenBox||isSale||savingsMatch||compMatch))continue;
      const ratingMatch=cardText.match(/([0-5](?:\.[0-9]+)?)\s*\((?:[0-9,]+)\s*reviews?\)/i);
      const modelMatch=cardText.match(/(?:model(?: number)?|mfr part(?: number)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})/i);
      out.push({source:"bestbuy",storeName:"Best Buy",title:title.slice(0,500),price:prices[0],sku,model:modelMatch?modelMatch[1]:null,url:href,rating:ratingMatch?Number(ratingMatch[1]):null,reviewCount:ratingMatch?Number((cardText.match(/\(([0-9,]+)\s*reviews?\)/i)||[])[1]?.replace(/,/g,""))||0:0,rawDescription:cardText,clearance:Boolean(forcedDealType==="clearance"||isClearance),isClearance:Boolean(forcedDealType==="clearance"||isClearance),isOpenBox,isSale,comparableValue:compMatch?Number(compMatch[1].replace(/,/g,"")):null,savings:savingsMatch?Number(savingsMatch[1].replace(/,/g,"")):null,dealType:forcedDealType||"search",dealLabel:forcedDealType||"Search"});
    }
    return out;
  },{requireDealSignal,forcedDealType,maxRaw});
}

function dedupe(rows,maxItems){const map=new Map();for(const row of rows){const key=row.sku?`sku:${row.sku}`:`title:${String(row.title).toLowerCase()}`;if(!map.has(key))map.set(key,row);if(map.size>=maxItems)break;}return [...map.values()].slice(0,maxItems);}

async function openPage(page,url,label){
  if(!(await robotsAllowed(url,"bestbuy")))throw new Error(`robots.txt disallowed ${label||url}`);
  await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000});
  await page.waitForTimeout(3500);
  const title=await page.title(),finalUrl=page.url();
  console.log(`  [bestbuy] ${label||"page"}: ${title}`);
  console.log(`  [bestbuy] url: ${finalUrl}`);
  return {title,finalUrl};
}

async function scrapeBestBuy(browser,query,maxItems,clearance=false,deals=false,bestBuyUrl=""){
  if(bestBuyUrl){
    return await scrapeBestBuySpecificUrl(browser,bestBuyUrl,maxItems);
  }
  const context=await browser.newContext({viewport:{width:1440,height:900},userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",locale:"en-US",timezoneId:"America/Chicago",extraHTTPHeaders:{"Accept-Language":"en-US,en;q=0.9"}});
  const page=await context.newPage();
  try{
    if(!clearance&&!deals){
      const url=`${BESTBUY_SEARCH}${encodeURIComponent(query||"")}&intl=nosplash`;
      const {title,finalUrl}=await openPage(page,url,`search: "${query}"`);
      if(isInternational(title,finalUrl))return [];
      await debugSnapshot("bestbuy",query,page);
      const rows=await extractProductCards(page,{maxRaw:maxItems*5});
      const products=dedupe(rows,maxItems);
      console.log(`  [bestbuy] "${query}" extracted ${rows.length} raw products`);
      console.log(`  [bestbuy] extracted ${products.length} unique products`);
      return products;
    }
    const targets=clearance?[{url:BESTBUY_CLEARANCE,label:"CLEARANCE",type:"clearance"}]:[{url:BESTBUY_TOP_DEALS,label:"TOP DEALS",type:"deal"},{url:BESTBUY_DEAL_OF_DAY,label:"DEAL OF THE DAY",type:"deal"},{url:BESTBUY_CLEARANCE,label:"CLEARANCE",type:"clearance"}];
    const all=[];
    for(const target of targets){
      try{const {title,finalUrl}=await openPage(page,target.url,target.label);if(isInternational(title,finalUrl)){console.warn(`  [bestbuy] ${target.label} redirected internationally; skipping.`);continue;}const rows=await extractProductCards(page,{requireDealSignal:true,forcedDealType:target.type,maxRaw:maxItems*8});console.log(`  [bestbuy] ${target.label} extracted ${rows.length} qualifying raw products`);all.push(...rows);}catch(err){console.warn(`  [bestbuy] ${target.label} failed: ${err.message||err}`);}
    }
    const products=dedupe(all,maxItems);
    console.log(`  [bestbuy] extracted ${products.length} unique ${clearance?"clearance":"deal"} products`);
    return products;
  }finally{await context.close();}
}

async function scrapeBestBuySpecificUrl(browser,bestBuyUrl,maxItems=10){
  const skuMatch=String(bestBuyUrl).match(/\/(\d{6,})(?:\/|[?#]|$)/);
  if(!skuMatch)throw new Error("Could not extract Best Buy SKU from --best-buy-url");
  const sku=skuMatch[1];
  console.log(`  [bestbuy] SPECIFIC PRODUCT URL: ${bestBuyUrl}`);
  console.log(`  [bestbuy] extracted SKU: ${sku}`);
  const context=await browser.newContext({viewport:{width:1440,height:900},userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",locale:"en-US",timezoneId:"America/Chicago"});
  const page=await context.newPage();
  try{
    const searchUrl=`${BESTBUY_SEARCH}${encodeURIComponent(sku)}&intl=nosplash`;
    const {title,finalUrl}=await openPage(page,searchUrl,`SKU search: ${sku}`);
    if(isInternational(title,finalUrl))return [];
    let rows=await extractProductCards(page,{maxRaw:30});
    let exact=rows.filter(p=>p.sku===sku);
    if(exact.length){console.log(`  [bestbuy] exact SKU ${sku} found via search`);return dedupe(exact,maxItems);}

    const parsed=new URL(bestBuyUrl);
    const slug=parsed.pathname.match(/\/product\/([^/]+)\//i)?.[1] || "";
    const titleQuery=decodeURIComponent(slug).replace(/-/g," ").trim();
    if(titleQuery){
      const fallbackUrl=`${BESTBUY_SEARCH}${encodeURIComponent(titleQuery)}&intl=nosplash`;
      const fallback=await openPage(page,fallbackUrl,`product title search: ${titleQuery}`);
      if(!isInternational(fallback.title,fallback.finalUrl)){
        rows=await extractProductCards(page,{maxRaw:50});
        exact=rows.filter(p=>p.sku===sku);
        if(exact.length){console.log(`  [bestbuy] exact SKU ${sku} found via title fallback`);return dedupe(exact,maxItems);}
      }
    }
    console.warn(`  [bestbuy] SKU ${sku} was not present in Best Buy search results.`);
    return [];
  }finally{await context.close();}
}

module.exports={scrapeBestBuy,scrapeBestBuySpecificUrl};
