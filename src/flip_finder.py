from __future__ import annotations

import argparse
import csv
import dataclasses
import json
import math
import re
import statistics
import time
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote_plus, urlparse
from urllib.robotparser import RobotFileParser

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from rapidfuzz import fuzz


CEDAR_FALLS_LAT = 42.5349
CEDAR_FALLS_LON = -92.4453
MILES_RADIUS_DEFAULT = 100.0

# Approximate city centroids used to enforce the 100-mile radius requirement
# without depending on third-party geocoding services.
CITY_CENTROIDS: dict[tuple[str, str], tuple[float, float]] = {
    ("cedar falls", "ia"): (42.5349, -92.4453),
    ("waterloo", "ia"): (42.4928, -92.3426),
    ("cedar rapids", "ia"): (41.9779, -91.6656),
    ("coralville", "ia"): (41.6764, -91.5804),
    ("iowa city", "ia"): (41.6611, -91.5302),
    ("williamsburg", "ia"): (41.6608, -92.0074),
    ("polk city", "ia"): (41.7719, -93.7124),
    ("ankeny", "ia"): (41.7318, -93.6001),
}


@dataclasses.dataclass(slots=True)
class Store:
    name: str
    city: str
    state: str
    address: str
    zip_code: str


@dataclasses.dataclass(slots=True)
class Product:
    store_name: str
    source: str
    title: str
    sku: str
    url: str
    price: float
    review_count: int
    rating: float | None = None


@dataclasses.dataclass(slots=True)
class FlipCandidate:
    title: str
    buy_store: str
    buy_price: float
    comp_store: str
    comp_price: float
    estimated_profit_pct: float
    confidence: float
    buy_url: str
    comp_url: str


def normalize(text: str) -> str:
    lowered = text.lower()
    lowered = re.sub(r"[^a-z0-9\s]", " ", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    return lowered


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_miles = 3958.7613
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius_miles * c


def read_stores(path: Path) -> list[Store]:
    stores: list[Store] = []
    with path.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            stores.append(
                Store(
                    name=row["name"].strip(),
                    city=row["city"].strip(),
                    state=row["state"].strip(),
                    address=row["address"].strip(),
                    zip_code=row["zip"].strip(),
                )
            )
    return stores


def filter_stores_in_radius(
    stores: Iterable[Store],
    center_lat: float,
    center_lon: float,
    radius_miles: float,
) -> list[Store]:
    kept: list[Store] = []
    for store in stores:
        key = (store.city.lower(), store.state.lower())
        coords = CITY_CENTROIDS.get(key)
        if not coords:
            continue
        distance = haversine_miles(center_lat, center_lon, coords[0], coords[1])
        if distance <= radius_miles:
            kept.append(store)
    return kept


def robots_allowed(url: str, user_agent: str = "*") -> bool:
    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    parser = RobotFileParser()
    parser.set_url(robots_url)
    try:
        parser.read()
    except Exception:
        # If robots cannot be fetched, fail closed for safety.
        return False
    return parser.can_fetch(user_agent, url)


def _find_first_list(node: Any, required_keys: set[str]) -> list[dict[str, Any]]:
    stack = [node]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            if required_keys.issubset(current.keys()):
                return [current]
            for value in current.values():
                stack.append(value)
        elif isinstance(current, list):
            if current and all(isinstance(x, dict) for x in current):
                keys_union: set[str] = set().union(
                    *[set(item.keys()) for item in current if isinstance(item, dict)]
                )
                if required_keys.issubset(keys_union):
                    return [x for x in current if isinstance(x, dict)]
            stack.extend(current)
    return []


def scrape_walmart_search(
    query: str,
    max_items: int,
    headless: bool = True,
    timeout_ms: int = 35000,
) -> list[Product]:
    search_url = f"https://www.walmart.com/search?q={quote_plus(query)}"
    if not robots_allowed(search_url):
        return []

    products: list[Product] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context()
        page = context.new_page()
        try:
            page.goto(search_url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(3500)
            html = page.content()
        except PlaywrightTimeoutError:
            context.close()
            browser.close()
            return []

        scripts = re.findall(
            r"<script[^>]*type=\"application/json\"[^>]*>(.*?)</script>",
            html,
            flags=re.DOTALL,
        )

        parsed_json_blobs: list[Any] = []
        for raw in scripts:
            raw = raw.strip()
            if not raw:
                continue
            try:
                parsed_json_blobs.append(json.loads(raw))
            except json.JSONDecodeError:
                continue

        candidate_items: list[dict[str, Any]] = []
        for blob in parsed_json_blobs:
            maybe_items = _find_first_list(blob, {"name"})
            if maybe_items:
                for item in maybe_items:
                    if "price" in json.dumps(item).lower() and "name" in item:
                        candidate_items.append(item)

        seen_titles: set[str] = set()
        for item in candidate_items:
            title = str(item.get("name") or "").strip()
            if not title:
                continue

            normalized_title = normalize(title)
            if normalized_title in seen_titles:
                continue

            as_text = json.dumps(item)
            price_match = re.search(r'"currentPrice"\s*:\s*\{[^\}]*"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)', as_text)
            if not price_match:
                price_match = re.search(r'"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)', as_text)
            if not price_match:
                continue

            price = float(price_match.group(1))
            if price <= 0:
                continue

            sku = ""
            sku_match = re.search(r'"usItemId"\s*:\s*"?([0-9]+)"?', as_text)
            if sku_match:
                sku = sku_match.group(1)

            url = ""
            url_match = re.search(r'"canonicalUrl"\s*:\s*"([^"]+)"', as_text)
            if url_match:
                url = "https://www.walmart.com" + url_match.group(1)

            review_count = 0
            review_match = re.search(r'"numberOfReviews"\s*:\s*([0-9]+)', as_text)
            if review_match:
                review_count = int(review_match.group(1))

            rating = None
            rating_match = re.search(r'"averageRating"\s*:\s*([0-9]+(?:\.[0-9]+)?)', as_text)
            if rating_match:
                rating = float(rating_match.group(1))

            products.append(
                Product(
                    store_name="Walmart",
                    source="walmart",
                    title=title,
                    sku=sku,
                    url=url or search_url,
                    price=price,
                    review_count=review_count,
                    rating=rating,
                )
            )
            seen_titles.add(normalized_title)
            if len(products) >= max_items:
                break

        context.close()
        browser.close()

    return products


def scrape_target_search(
    query: str,
    max_items: int,
    headless: bool = True,
    timeout_ms: int = 35000,
) -> list[Product]:
    search_url = f"https://www.target.com/s?searchTerm={quote_plus(query)}"
    if not robots_allowed(search_url):
        return []

    products: list[Product] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context()
        page = context.new_page()
        try:
            page.goto(search_url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(4500)
            html = page.content()
        except PlaywrightTimeoutError:
            context.close()
            browser.close()
            return []

        next_data_match = re.search(
            r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
            html,
            flags=re.DOTALL,
        )
        if not next_data_match:
            context.close()
            browser.close()
            return []

        try:
            payload = json.loads(next_data_match.group(1))
        except json.JSONDecodeError:
            context.close()
            browser.close()
            return []

        all_dicts = _find_first_list(payload, {"tcin"})
        seen_titles: set[str] = set()
        for item in all_dicts:
            title = str(item.get("title") or item.get("name") or "").strip()
            if not title:
                continue

            as_text = json.dumps(item)
            price_match = re.search(r'"current_retail"\s*:\s*([0-9]+(?:\.[0-9]+)?)', as_text)
            if not price_match:
                price_match = re.search(r'"formatted_current_price"\s*:\s*"\$?([0-9]+(?:\.[0-9]+)?)"', as_text)
            if not price_match:
                continue

            price = float(price_match.group(1))
            if price <= 0:
                continue

            normalized_title = normalize(title)
            if normalized_title in seen_titles:
                continue

            tcin = str(item.get("tcin") or "")
            url = f"https://www.target.com/p/-/A-{tcin}" if tcin else search_url

            review_count = 0
            review_match = re.search(r'"total_count"\s*:\s*([0-9]+)', as_text)
            if review_match:
                review_count = int(review_match.group(1))

            rating = None
            rating_match = re.search(r'"average"\s*:\s*([0-9]+(?:\.[0-9]+)?)', as_text)
            if rating_match:
                rating = float(rating_match.group(1))

            products.append(
                Product(
                    store_name="Target",
                    source="target",
                    title=title,
                    sku=tcin,
                    url=url,
                    price=price,
                    review_count=review_count,
                    rating=rating,
                )
            )
            seen_titles.add(normalized_title)
            if len(products) >= max_items:
                break

        context.close()
        browser.close()

    return products


def match_products(products: list[Product], min_similarity: int = 82) -> list[FlipCandidate]:
    candidates: list[FlipCandidate] = []

    for i, buy in enumerate(products):
        for j, comp in enumerate(products):
            if i == j:
                continue
            if buy.store_name == comp.store_name:
                continue

            sim = fuzz.token_set_ratio(normalize(buy.title), normalize(comp.title))
            if sim < min_similarity:
                continue

            if buy.price <= 0 or comp.price <= 0:
                continue
            if comp.price <= buy.price:
                continue

            profit_pct = ((comp.price - buy.price) / buy.price) * 100.0
            if profit_pct <= 0:
                continue

            rating_signal = 0.0
            if buy.rating is not None:
                rating_signal = min(1.0, buy.rating / 5.0)
            review_signal = min(1.0, math.log10(max(1, buy.review_count + 1)) / 4.0)
            confidence = min(1.0, (sim / 100.0) * 0.6 + rating_signal * 0.2 + review_signal * 0.2)

            candidates.append(
                FlipCandidate(
                    title=buy.title,
                    buy_store=buy.store_name,
                    buy_price=buy.price,
                    comp_store=comp.store_name,
                    comp_price=comp.price,
                    estimated_profit_pct=profit_pct,
                    confidence=confidence,
                    buy_url=buy.url,
                    comp_url=comp.url,
                )
            )

    # Deduplicate by (title,buy_store,comp_store) and keep best profit.
    best: dict[tuple[str, str, str], FlipCandidate] = {}
    for c in candidates:
        key = (normalize(c.title), c.buy_store, c.comp_store)
        prev = best.get(key)
        if prev is None or c.estimated_profit_pct > prev.estimated_profit_pct:
            best[key] = c

    return sorted(best.values(), key=lambda x: x.estimated_profit_pct, reverse=True)


def select_easy_to_sell(candidates: list[FlipCandidate], threshold: float) -> list[FlipCandidate]:
    return [c for c in candidates if c.estimated_profit_pct >= threshold and c.confidence >= 0.55]


def run_scan(
    query: str,
    max_items_per_store: int,
    min_profit_pct: float,
    use_headless: bool,
) -> dict[str, Any]:
    started = time.time()

    stores_path = Path("data/stores.csv")
    stores = read_stores(stores_path)
    in_radius = filter_stores_in_radius(stores, CEDAR_FALLS_LAT, CEDAR_FALLS_LON, MILES_RADIUS_DEFAULT)

    enabled_store_names = {"walmart supercenter", "target"}
    enabled_stores = [s for s in in_radius if s.name.lower() in enabled_store_names]

    all_products: list[Product] = []
    if any("walmart" in s.name.lower() for s in enabled_stores):
        all_products.extend(
            scrape_walmart_search(
                query=query,
                max_items=max_items_per_store,
                headless=use_headless,
            )
        )

    if any("target" in s.name.lower() for s in enabled_stores):
        all_products.extend(
            scrape_target_search(
                query=query,
                max_items=max_items_per_store,
                headless=use_headless,
            )
        )

    matches = match_products(all_products)
    profitable = select_easy_to_sell(matches, min_profit_pct)

    runtime_sec = round(time.time() - started, 2)
    return {
        "query": query,
        "runtime_sec": runtime_sec,
        "stores_considered": [s.name for s in in_radius],
        "products_scraped": len(all_products),
        "candidates_found": len(matches),
        "profitable_candidates": [dataclasses.asdict(c) for c in profitable],
    }


def print_report(report: dict[str, Any], top_n: int) -> None:
    print(f"Query: {report['query']}")
    print(f"Runtime: {report['runtime_sec']} sec")
    print(f"Products scraped: {report['products_scraped']}")
    print(f"Cross-store candidates: {report['candidates_found']}")

    profitable = report["profitable_candidates"]
    if not profitable:
        print("No >= threshold flip candidates found in this run.")
        return

    print("\nTop profitable candidates:")
    for idx, row in enumerate(profitable[:top_n], start=1):
        print(
            f"{idx}. {row['title']} | buy: {row['buy_store']} ${row['buy_price']:.2f} "
            f"| comp: {row['comp_store']} ${row['comp_price']:.2f} "
            f"| est profit: {row['estimated_profit_pct']:.1f}% "
            f"| confidence: {row['confidence']:.2f}"
        )
        print(f"   buy url: {row['buy_url']}")
        print(f"   comp url: {row['comp_url']}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Scrape public retail search pages near Cedar Falls, IA and identify "
            "cross-store price gaps that can support 50%+ flip margins."
        )
    )
    parser.add_argument("--query", type=str, default="cordless drill", help="Search term")
    parser.add_argument(
        "--max-items-per-store",
        type=int,
        default=25,
        help="Maximum items to keep from each store",
    )
    parser.add_argument(
        "--min-profit-pct",
        type=float,
        default=50.0,
        help="Minimum estimated profit percent",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=5,
        help="Number of top candidates to print",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Show browser windows while scraping",
    )
    parser.add_argument(
        "--json-out",
        type=str,
        default="",
        help="Optional output path for JSON report",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = run_scan(
        query=args.query,
        max_items_per_store=args.max_items_per_store,
        min_profit_pct=args.min_profit_pct,
        use_headless=not args.headed,
    )
    print_report(report, top_n=args.top_n)

    if args.json_out:
        out_path = Path(args.json_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nSaved JSON report to: {out_path}")


if __name__ == "__main__":
    main()
