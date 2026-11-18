// Price rules shared by the scrape steps: the same safety checks as pipeline/scraper.py
// (quorum confirmation, coverage thresholds, carry-forward, change-only history).
// Price arrays are [regular, premium, diesel] with null for a grade not sold.

export const GRADE_COUNT = 3;
export const MAX_RECHECK_ATTEMPTS = 5;
export const CONFIRMATION_QUORUM = 3;
export const PRICE_MATCH_TOLERANCE = 0.01;
export const SNAPSHOT_STATE_COVERAGE_THRESHOLD = 0.85;
export const SNAPSHOT_STORE_COVERAGE_THRESHOLD = 0.75;
export const TREND_LOOKBACK_HOURS = 72;

const SCRAPER_TZ = "America/Los_Angeles";

// "$4.299" -> 4.3, "" / "n/a" / junk -> null. toFixed rounds the stored binary value the
// way Python's round() does, so both scrapers agree on halfway cases.
export function formatPrice(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace("$", "").trim();
  if (text === "" || text.toLowerCase() === "n/a") return null;
  const num = Number(text);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : null;
}

export function pricesMatch(a, b, tol = PRICE_MATCH_TOLERANCE) {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === null && (b ?? null) === null;
  }
  return Math.abs(a - b) < tol;
}

// Returns the agreed value if `quorum` samples agree (preferring the most recent cluster),
// or undefined if no value has reached quorum yet. null is a valid agreed value.
export function findQuorum(samples, quorum = CONFIRMATION_QUORUM) {
  const clusters = [];
  for (const val of samples) {
    const cluster = clusters.find((c) => pricesMatch(c[0], val));
    if (cluster) cluster.push(val);
    else clusters.push([val]);
  }
  const winning = clusters.filter((c) => c.length >= quorum);
  if (winning.length === 0) return undefined;
  for (let i = samples.length - 1; i >= 0; i--) {
    const cluster = winning.find((c) => pricesMatch(c[0], samples[i]));
    if (cluster) return cluster[0];
  }
  return winning[winning.length - 1][0];
}

export function gradesOf(prices) {
  return Array.from({ length: GRADE_COUNT }, (_, i) => (prices && i < prices.length ? prices[i] : null));
}

export function hasBaseline(last) {
  return Array.isArray(last) && gradesOf(last).some((v) => v !== null);
}

export function differsFrom(prices, last) {
  const a = gradesOf(prices);
  const b = gradesOf(last);
  return a.some((v, i) => !pricesMatch(v, b[i]));
}

// Re-fetches a store whose price changed until `quorum` samples agree for each changed grade.
// A grade that can't be confirmed reverts to the last known price. `refetch` returns a price
// array or null (failed fetch); it is called at most `maxFetches` times.
export async function confirmOrRevert(first, last, refetch, {
  maxSamples = MAX_RECHECK_ATTEMPTS,
  maxFetches = MAX_RECHECK_ATTEMPTS + 3,
  quorum = CONFIRMATION_QUORUM,
} = {}) {
  const firstGrades = gradesOf(first);
  const lastGrades = gradesOf(last);
  const pending = firstGrades.map((v, i) => !pricesMatch(v, lastGrades[i]));
  const samples = firstGrades.map(() => []);
  const final = [...firstGrades];
  let taken = 0;

  for (let fetches = 0; fetches < maxFetches && taken < maxSamples && pending.some(Boolean); fetches++) {
    const recheck = await refetch();
    if (!recheck) continue;
    taken++;
    const grades = gradesOf(recheck);
    for (let g = 0; g < GRADE_COUNT; g++) {
      if (!pending[g]) continue;
      samples[g].push(grades[g]);
      const agreed = findQuorum(samples[g], quorum);
      if (agreed !== undefined) {
        final[g] = agreed;
        pending[g] = false;
      } else {
        final[g] = grades[g];
      }
    }
  }

  const unconfirmed = pending.some(Boolean);
  pending.forEach((p, g) => { if (p) final[g] = lastGrades[g]; });
  return { prices: final, unconfirmed, samples };
}

export function countStores(byState) {
  return Object.values(byState).reduce((n, cities) => n + Object.keys(cities).length, 0);
}

export function validateSnapshot(fetched, locations) {
  const expectedStates = Object.keys(locations).length;
  const actualStates = Object.keys(fetched).filter((s) => Object.keys(fetched[s]).length).length;
  const expectedStores = countStores(locations);
  const actualStores = countStores(fetched);
  if (expectedStates === 0) return { ok: true, reason: "no expected states to compare against" };

  const stateCov = actualStates / expectedStates;
  const storeCov = expectedStores ? actualStores / expectedStores : 0;
  const pct = (x) => `${Math.round(x * 100)}%`;
  if (stateCov < SNAPSHOT_STATE_COVERAGE_THRESHOLD) {
    return { ok: false, reason: `only ${actualStates}/${expectedStates} states (${pct(stateCov)}) returned any price data - below the ${pct(SNAPSHOT_STATE_COVERAGE_THRESHOLD)} threshold` };
  }
  if (storeCov < SNAPSHOT_STORE_COVERAGE_THRESHOLD) {
    return { ok: false, reason: `only ${actualStores}/${expectedStores} stores (${pct(storeCov)}) returned price data - below the ${pct(SNAPSHOT_STORE_COVERAGE_THRESHOLD)} threshold` };
  }
  return { ok: true, reason: `${actualStates}/${expectedStates} states, ${actualStores}/${expectedStores} stores` };
}

// Sorted copy of {state: {city: value}}, dropping empty states. Matches the key order the
// Python scraper writes, so the history file stays consistent whichever scraper wrote it.
export function sortStores(byState) {
  const out = {};
  for (const state of Object.keys(byState).sort()) {
    const cities = byState[state] || {};
    const names = Object.keys(cities).sort();
    if (names.length === 0) continue;
    out[state] = {};
    for (const city of names) out[state][city] = cities[city];
  }
  return out;
}

// Stores that returned nothing this run keep their last known price, but only if they are
// still in the store list.
export function carryForwardMissing(fetched, lastKnown, locations) {
  const merged = {};
  for (const [state, cities] of Object.entries(fetched)) merged[state] = { ...cities };
  let carried = 0;
  for (const [state, cities] of Object.entries(locations)) {
    for (const city of Object.keys(cities)) {
      if (merged[state] && city in merged[state]) continue;
      const prev = lastKnown?.[state]?.[city];
      if (prev !== undefined && prev !== null) {
        (merged[state] ||= {})[city] = prev;
        carried++;
      }
    }
  }
  return { merged: sortStores(merged), carried };
}

function samePrices(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export function computePriceDeltas(next, previous) {
  const deltas = {};
  for (const [state, cities] of Object.entries(sortStores(next))) {
    for (const [city, price] of Object.entries(cities)) {
      if (!samePrices(price, previous?.[state]?.[city])) (deltas[state] ||= {})[city] = price;
    }
  }
  return deltas;
}

// Current Pacific wall-clock time as "YYYY-MM-DD HH:MM".
export function pacificTimestamp(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: SCRAPER_TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// Wall-clock arithmetic on a "YYYY-MM-DD HH:MM" string, like the Python scraper's naive
// datetime maths (so a lookback across a DST change is 72 wall-clock hours).
export function shiftTimestamp(ts, hours) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(ts);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + hours * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

// Applies change-only history entries ({ts: {state: {city: price}}}, oldest first) on top of
// a full price map.
export function applyEntries(base, entries) {
  const out = {};
  for (const [state, cities] of Object.entries(base || {})) out[state] = { ...cities };
  for (const delta of entries) {
    for (const [state, cities] of Object.entries(delta)) {
      for (const [city, price] of Object.entries(cities)) (out[state] ||= {})[city] = price;
    }
  }
  return sortStores(out);
}
