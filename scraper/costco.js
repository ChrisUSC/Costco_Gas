// One request to Costco's gas-price endpoint for one warehouse.
import { formatPrice, gradesOf } from "./prices.js";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
];
const GRADES = ["regular", "premium", "diesel"];

export function priceUrl(warehouseId) {
  // A unique query string so no cache along the way can answer a recheck with an old reply.
  const nonce = `${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`;
  return `https://www.costco.com/AjaxGetGasPricesService?warehouseid=${encodeURIComponent(warehouseId)}&_=${nonce}`;
}

// Reads {"<id>": {"regular": "4.29", "premium": "4.69", "diesel": ""}} into [4.29, 4.69, null].
// Returns null if no grade has a price.
export function parsePriceResponse(data) {
  if (!data || typeof data !== "object") return null;
  const inner = Object.values(data)[0];
  if (!inner || typeof inner !== "object") return null;
  const lower = Object.fromEntries(Object.entries(inner).map(([k, v]) => [k.toLowerCase(), v]));
  const prices = gradesOf(GRADES.map((g) => formatPrice(lower[g])));
  return prices.some((v) => v !== null) ? prices : null;
}

// Returns { status, prices } where status is the HTTP status (0 for a network error or
// timeout) and prices is a price array or null.
export async function fetchStorePrices(fetchFn, warehouseId, timeoutMs = 15000) {
  try {
    const res = await fetchFn(priceUrl(warehouseId), {
      headers: {
        "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        Accept: "application/json, text/plain, */*",
        "Cache-Control": "no-cache, no-store",
        Pragma: "no-cache",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { status: res.status, prices: null };
    let data;
    try {
      data = await res.json();
    } catch {
      return { status: res.status, prices: null, error: "not JSON" };
    }
    return { status: res.status, prices: parsePriceResponse(data) };
  } catch (e) {
    return { status: 0, prices: null, error: String(e?.message || e) };
  }
}
