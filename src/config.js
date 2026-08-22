const fs = require("node:fs");
const path = require("node:path");

const CEDAR_FALLS = { lat: 42.5349, lon: -92.4453 };
const DEFAULT_RADIUS_MILES = 100;
const CITY_CENTROIDS = {
  "cedar falls,ia": { lat: 42.5349, lon: -92.4453 },
  "waterloo,ia": { lat: 42.4928, lon: -92.3426 },
  "cedar rapids,ia": { lat: 41.9779, lon: -91.6656 },
  "coralville,ia": { lat: 41.6764, lon: -91.5804 },
  "iowa city,ia": { lat: 41.6611, lon: -91.5302 },
  "williamsburg,ia": { lat: 41.6608, lon: -92.0074 },
  "polk city,ia": { lat: 41.7719, lon: -93.7124 },
  "ankeny,ia": { lat: 41.7318, lon: -93.6001 },
  "marshalltown,ia": { lat: 42.0492, lon: -92.9070 },
  "mason city,ia": { lat: 43.1536, lon: -93.2010 },
  "ames,ia": { lat: 42.0347, lon: -93.6200 },
  "reinbeck,ia": { lat: 42.3050, lon: -92.5990 },
  "jesup,ia": { lat: 42.4755, lon: -92.0646 },
  "new hampton,ia": { lat: 43.0591, lon: -92.3176 },
  "marengo,ia": { lat: 41.7981, lon: -92.0685 },
  "victor,ia": { lat: 41.7333, lon: -92.2896 },
  "swisher,ia": { lat: 41.8475, lon: -91.6913 },
};
const SOURCE_TO_STORE_NAMES = { bestbuy: ["Best Buy"] };

function parseArgs(argv) {
  const args = { query: "", bestBuyUrl: "", maxItemsPerStore: 25, minProfitPct: 50, topN: 5, jsonOut: "", headed: false, refresh: false, clearance: false, deals: false, sellFeePct: 15, shippingCost: 0 };
  for (let i = 2; i < argv.length; i += 1) {
    const v = argv[i]; const next = argv[i + 1];
    if (v === "--query" && next) args.query = next, i++;
    else if (v === "--best-buy-url" && next) args.bestBuyUrl = next, i++;
    else if (v === "--max-items-per-store" && next) args.maxItemsPerStore = Number(next), i++;
    else if (v === "--min-profit-pct" && next) args.minProfitPct = Number(next), i++;
    else if (v === "--top-n" && next) args.topN = Number(next), i++;
    else if (v === "--json-out" && next) args.jsonOut = next, i++;
    else if (v === "--headed") args.headed = true;
    else if (v === "--refresh") args.refresh = true;
    else if (v === "--clearance") args.clearance = true;
    else if (v === "--deals") args.deals = true;
    else if (v === "--sell-fee-pct" && next) args.sellFeePct = Number(next), i++;
    else if (v === "--shipping-cost" && next) args.shippingCost = Number(next), i++;
  }
  return args;
}
function resolveBudgetProfile(args) { return { mode: "normal", maxItemsPerStore: args.maxItemsPerStore, useCache: true, cacheTtlMinutes: 90, enableBestBuy: true }; }
function getCachePath(query) { return path.join(process.cwd(), "output", "cache", `${normalize(query).replace(/\s+/g, "-") || "query"}.json`); }
function readCache(cachePath, ttlMinutes) {
  if (!fs.existsSync(cachePath)) return null;
  try { const parsed=JSON.parse(fs.readFileSync(cachePath,"utf8")); const t=new Date(parsed.generatedAt||0).getTime(); if(!t || (Date.now()-t)/60000>ttlMinutes) return null; return parsed; } catch { return null; }
}
function writeCache(cachePath, report) { fs.mkdirSync(path.dirname(cachePath),{recursive:true}); fs.writeFileSync(cachePath,JSON.stringify(report,null,2),"utf8"); }
function normalize(text) { return String(text||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim(); }
function tokenSetSimilarity(a,b) { const A=new Set(normalize(a).split(" ").filter(Boolean)); const B=new Set(normalize(b).split(" ").filter(Boolean)); if(!A.size||!B.size)return 0; let i=0; for(const x of A)if(B.has(x))i++; return i/(A.size+B.size-i); }
function detectBrand(title) { const brands=["apple","samsung","sony","lenovo","hp","dell","asus","acer","lg","google","microsoft","nintendo","playstation","xbox","dewalt","milwaukee","makita","bosch","ryobi","worx","greenworks","anker","jbl","bose","insignia","tp-link","vevor"]; const n=normalize(title); return brands.find(b=>n.includes(b))||null; }
function haversineMiles(lat1,lon1,lat2,lon2){const R=3958.7613;const dLat=(lat2-lat1)*Math.PI/180;const dLon=(lon2-lon1)*Math.PI/180;const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
function parseCsv(filePath){const text=fs.readFileSync(filePath,"utf8").replace(/^\uFEFF/,"");const rows=[];let row=[],cell="",quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell.trim());cell="";}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell.trim());if(row.some(Boolean))rows.push(row);row=[];cell="";}else cell+=c;}if(cell||row.length){row.push(cell.trim());rows.push(row);}const headers=rows.shift()||[];return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]||""])));}
function storesWithinRadius(rows,radiusMiles){return rows.map(s=>{const lat=Number(s.lat),lon=Number(s.lon);if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;const d=haversineMiles(CEDAR_FALLS.lat,CEDAR_FALLS.lon,lat,lon);return {...s,distanceFromCedarFallsMiles:Number(d.toFixed(2)),withinCedarFallsRadius:d<=radiusMiles};}).filter(Boolean).filter(s=>s.withinCedarFallsRadius);}
async function robotsAllowed(url,label=""){try{const base=new URL(url);const robotsUrl=`${base.protocol}//${base.host}/robots.txt`;const res=await fetch(robotsUrl,{headers:{"User-Agent":"Mozilla/5.0"}});if(!res.ok)return true;const txt=await res.text();let applies=false,allowed=true;for(const raw of txt.split(/\r?\n/)){const line=raw.split("#")[0].trim();if(!line)continue;const [k,v]=line.split(":",2).map(x=>x.trim());if(k.toLowerCase()==="user-agent")applies=v==="*"||v.toLowerCase().includes("mozilla");else if(applies&&k.toLowerCase()==="disallow"&&v&&new URL(url).pathname.startsWith(v))allowed=false;else if(applies&&k.toLowerCase()==="allow"&&v&&new URL(url).pathname.startsWith(v))allowed=true;}return allowed;}catch{return true;}}
async function debugSnapshot(label,query,page){if(process.env.FLIP_FINDER_DEBUG!=="1")return;const dir=path.join(process.cwd(),"output","debug");fs.mkdirSync(dir,{recursive:true});const safe=normalize(`${label}-${query}`).replace(/\s+/g,"-").slice(0,80)||"page";try{await page.screenshot({path:path.join(dir,`${safe}.png`),fullPage:true});fs.writeFileSync(path.join(dir,`${safe}.html`),await page.content(),"utf8");}catch{} }
function cleanPrice(value){const n=Number(String(value??"").replace(/[$,]/g,""));return Number.isFinite(n)?n:null;}
module.exports={CEDAR_FALLS,DEFAULT_RADIUS_MILES,CITY_CENTROIDS,SOURCE_TO_STORE_NAMES,parseArgs,resolveBudgetProfile,getCachePath,readCache,writeCache,normalize,tokenSetSimilarity,detectBrand,haversineMiles,parseCsv,storesWithinRadius,robotsAllowed,debugSnapshot,cleanPrice};
