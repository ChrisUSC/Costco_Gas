import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEntries, carryForwardMissing, computePriceDeltas, confirmOrRevert, findQuorum, formatPrice,
  pacificTimestamp, shiftTimestamp, validateSnapshot,
} from "../../scraper/prices.js";

test("formatPrice matches the Python scraper", () => {
  assert.equal(formatPrice("$4.299"), 4.3);
  assert.equal(formatPrice(" 3.45 "), 3.45);
  assert.equal(formatPrice("4.295"), 4.29); // Python: round(4.295, 2) == 4.29
  assert.equal(formatPrice(""), null);
  assert.equal(formatPrice("N/A"), null);
  assert.equal(formatPrice("abc"), null);
  assert.equal(formatPrice(null), null);
});

test("findQuorum needs three agreeing samples and prefers the latest cluster", () => {
  assert.equal(findQuorum([4.1, 4.2, 4.1]), undefined);
  assert.equal(findQuorum([4.1, 4.1, 4.105]), 4.1);
  assert.equal(findQuorum([null, null, null]), null);
  assert.equal(findQuorum([4.1, 4.1, 4.1, 4.2, 4.2, 4.2]), 4.2);
});

test("confirmOrRevert confirms a real change", async () => {
  const out = await confirmOrRevert([4.0, 4.5, null], [3.9, 4.5, null], async () => [4.0, 4.5, null]);
  assert.deepEqual(out.prices, [4.0, 4.5, null]);
  assert.equal(out.unconfirmed, false);
});

test("confirmOrRevert reverts a change that won't settle", async () => {
  const seq = [[4.0, 4.5, null], [3.9, 4.5, null], [4.1, 4.5, null], [4.0, 4.5, null], [3.8, 4.5, null]];
  let i = 0;
  const out = await confirmOrRevert([4.0, 4.5, null], [3.9, 4.5, null], async () => seq[i++]);
  assert.deepEqual(out.prices, [3.9, 4.5, null]);
  assert.equal(out.unconfirmed, true);
});

test("confirmOrRevert skips failed fetches but stops at maxFetches", async () => {
  let calls = 0;
  const out = await confirmOrRevert([4.0, null, null], [3.9, null, null], async () => { calls++; return null; }, { maxFetches: 4 });
  assert.equal(calls, 4);
  assert.deepEqual(out.prices, [3.9, null, null]);
});

test("validateSnapshot applies the 85% state and 75% store thresholds", () => {
  const locations = {};
  for (let s = 0; s < 20; s++) locations[`S${s}`] = { a: true, b: true };
  const fetched = {};
  for (let s = 0; s < 17; s++) fetched[`S${s}`] = { a: [1, 2, 3], b: [1, 2, 3] };
  assert.equal(validateSnapshot(fetched, locations).ok, true);
  delete fetched.S16;
  assert.equal(validateSnapshot(fetched, locations).ok, false);
  for (let s = 0; s < 17; s++) fetched[`S${s}`] = { a: [1, 2, 3] };
  assert.match(validateSnapshot(fetched, locations).reason, /stores/);
});

test("carryForwardMissing fills gaps only for stores still listed", () => {
  const { merged, carried } = carryForwardMissing(
    { CA: { Tracy: [4, 5, null] } },
    { CA: { Tracy: [3, 4, null], Turlock: [3.5, 4.5, null], Closed: [1, 1, 1] } },
    { CA: { Tracy: true, Turlock: true } },
  );
  assert.deepEqual(merged, { CA: { Tracy: [4, 5, null], Turlock: [3.5, 4.5, null] } });
  assert.equal(carried, 1);
});

test("computePriceDeltas keeps only changed stores", () => {
  assert.deepEqual(
    computePriceDeltas({ CA: { A: [1, 2, null], B: [3, 4, null] }, TX: { C: [1, 1, 1] } }, { CA: { A: [1, 2, null], B: [3, 4.1, null] } }),
    { CA: { B: [3, 4, null] }, TX: { C: [1, 1, 1] } },
  );
});

test("pacificTimestamp is Pacific wall-clock time across DST", () => {
  assert.equal(pacificTimestamp(new Date("2026-07-01T17:05:00Z")), "2026-07-01 10:05");
  assert.equal(pacificTimestamp(new Date("2026-12-01T17:05:00Z")), "2026-12-01 09:05");
  assert.equal(pacificTimestamp(new Date("2026-07-01T07:30:00Z")), "2026-07-01 00:30");
});

test("shiftTimestamp does naive wall-clock arithmetic", () => {
  assert.equal(shiftTimestamp("2026-03-03 10:00", -72), "2026-02-28 10:00");
  assert.equal(shiftTimestamp("bad", -72), null);
});

test("applyEntries replays deltas oldest first", () => {
  assert.deepEqual(
    applyEntries({ CA: { A: [1, 1, 1] } }, [{ CA: { A: [2, 2, 2] } }, { CA: { A: [3, 3, 3] }, TX: { B: [4, 4, 4] } }]),
    { CA: { A: [3, 3, 3] }, TX: { B: [4, 4, 4] } },
  );
});
