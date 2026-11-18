// The hourly scrape, split into small steps so each fits the free Workers plan
// (10 ms CPU and 50 outbound requests per invocation):
//
//   start    (cron, :00)  reads us_latest.json, splits the stores into chunks, queues one
//                         message per chunk and records the run in runs/us/current.json.
//   chunk    (queue)      fetches every store in its chunk once (retrying failures). Stores
//                         whose price changed are queued as `verify` messages; the rest are
//                         written to runs/us/<run>/p1-<n>-v<verify messages>.json.
//   verify   (queue)      re-fetches each changed store until a quorum agrees, or reverts it
//                         to the last known price; writes runs/us/<run>/v-<id>.json.
//   finalize              merges the results, applies the coverage check, appends changes to
//                         us_history.json, writes us_latest.json and deletes the run's files.
//
// Finalize runs as soon as the last chunk or verify message finishes (it lists the run's files
// to see that every chunk, and every verify message the chunks asked for, has written one), so
// a normal run is saved a couple of minutes after :00. Whoever finalizes first claims the run
// with a conditional write to current.json, so it can't be saved twice. The :10 cron is the
// backstop: if a message failed or got stuck, it finalizes with what arrived, and the missing
// stores are handled by the coverage check and carry-forward (a changed store keeps its old price).
import { fetchStorePrices } from "./costco.js";
import {
  applyEntries, carryForwardMissing, computePriceDeltas, confirmOrRevert, countStores,
  differsFrom, hasBaseline, pacificTimestamp, shiftTimestamp, sortStores, TREND_LOOKBACK_HOURS,
  validateSnapshot,
} from "./prices.js";
import { appendHistory, copyObject, inspectHistory, readEntriesBetween, seedHistory } from "./history.js";

export const CHUNK_SIZE = 20;
export const VERIFY_GROUP = 5;
const FETCH_BUDGET = 45; // of the 50 outbound requests a free-plan invocation may make
const MAX_FETCH_ATTEMPTS = 5;
const CONCURRENCY = 4;
const LATEST_METADATA = { contentType: "application/json", cacheControl: "public, max-age=300" };

export function keys(prefix = "") {
  return {
    latest: `${prefix}us_latest.json`,
    history: `${prefix}us_history.json`,
    pointer: `${prefix}runs/us/current.json`,
    run: (runId) => `${prefix}runs/us/${runId}/`,
    backup: (day) => `${prefix}backups/us_history_${day}.json`,
  };
}

// [{ s: state, c: city, w: warehouse id }] from public/us_stores.json, sorted.
export function compactStores(usStores) {
  const list = [];
  for (const state of Object.keys(usStores).sort()) {
    for (const city of Object.keys(usStores[state]).sort()) {
      const id = usStores[state][city]?.warehouse_id;
      if (id) list.push({ s: state, c: city, w: String(id) });
    }
  }
  return list;
}

export function locationsFrom(storeList) {
  const out = {};
  for (const { s, c } of storeList) (out[s] ||= {})[c] = true;
  return out;
}

async function readJson(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  const text = await obj.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${key} isn't valid JSON (${e.message}); stopping rather than overwriting it`, { cause: e });
  }
}

function putJson(bucket, key, value, httpMetadata = { contentType: "application/json" }) {
  return bucket.put(key, JSON.stringify(value), { httpMetadata });
}

async function listKeys(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    out.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function deleteRun(bucket, k, runId) {
  const runKeys = await listKeys(bucket, k.run(runId));
  for (let i = 0; i < runKeys.length; i += 1000) await bucket.delete(runKeys.slice(i, i + 1000));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function tally(statuses, status) {
  statuses[status] = (statuses[status] || 0) + 1;
}

// Shadow mode (a non-empty prefix) starts from a copy of the live files, then keeps its own.
async function bootstrapShadow(bucket, prefix) {
  const k = keys(prefix);
  if (await bucket.head(k.latest)) return;
  const live = keys("");
  await copyObject(bucket, live.latest, k.latest, LATEST_METADATA);
  await copyObject(bucket, live.history, k.history, { contentType: "application/json", cacheControl: "public, max-age=3600" });
}

async function isCurrentRun(bucket, k, runId) {
  const pointer = await readJson(bucket, k.pointer);
  return pointer?.runId === runId && !pointer.finalizing;
}

const CHUNK_RESULT = /^p1-\d+-v(\d+)\.json$/;

// True once every chunk and every verify message the chunks queued has written its result.
// One R2 list per call; only file names are read.
export function runComplete(runKeys, chunks) {
  let chunksDone = 0;
  let verifiesExpected = 0;
  let verifiesDone = 0;
  for (const key of runKeys) {
    const name = key.slice(key.lastIndexOf("/") + 1);
    const m = CHUNK_RESULT.exec(name);
    if (m) {
      chunksDone++;
      verifiesExpected += Number(m[1]);
    } else if (name.startsWith("v-")) {
      verifiesDone++;
    }
  }
  return chunksDone === chunks && verifiesDone >= verifiesExpected;
}

// Claims the run for finalizing by marking current.json, with a conditional write so only one
// caller can win. A claim older than `staleAfterMs` (a finalize that crashed) can be taken over.
async function claimRun(bucket, k, { runId, staleAfterMs, now }) {
  const obj = await bucket.get(k.pointer);
  if (!obj) return null;
  const pointer = JSON.parse(await obj.text());
  if (!pointer?.runId || (runId && pointer.runId !== runId)) return null;
  if (pointer.finalizing && now() - Date.parse(pointer.finalizing) < staleAfterMs) return null;
  const won = await bucket.put(k.pointer, JSON.stringify({ ...pointer, finalizing: now().toISOString() }), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagMatches: obj.etag },
  });
  return won ? pointer : null;
}

// Called after a chunk or verify result is written: finalizes if that was the last one.
async function finalizeIfComplete(deps, runId) {
  const k = keys(deps.prefix);
  const pointer = await readJson(deps.bucket, k.pointer);
  if (pointer?.runId !== runId || pointer.finalizing) return undefined;
  if (!runComplete(await listKeys(deps.bucket, k.run(runId)), pointer.chunks)) return undefined;
  return finalizeRun({ ...deps, runId, early: true });
}

export async function startRun({ bucket, queue, storeList, prefix = "", now = () => new Date(), log = console.log }) {
  const k = keys(prefix);
  if (prefix) await bootstrapShadow(bucket, prefix);

  const old = await readJson(bucket, k.pointer);
  if (old?.runId) log(`Previous run ${old.runId} was never finalized; discarding its partial results.`);
  // Also clears files a late chunk wrote after its run was finalized.
  const leftovers = (await listKeys(bucket, k.run("").slice(0, -1))).filter((key) => key !== k.pointer);
  for (let i = 0; i < leftovers.length; i += 1000) await bucket.delete(leftovers.slice(i, i + 1000));

  const latest = await readJson(bucket, k.latest);
  const lastKnown = latest?.prices || {};
  const timestamp = pacificTimestamp(now());
  const runId = timestamp.replace(/[-: ]/g, "");

  const messages = [];
  for (let i = 0; i < storeList.length; i += CHUNK_SIZE) {
    const stores = storeList.slice(i, i + CHUNK_SIZE).map((st) => ({ ...st, last: lastKnown[st.s]?.[st.c] ?? null }));
    messages.push({ body: { type: "chunk", prefix, runId, index: messages.length, stores } });
  }
  await putJson(bucket, k.pointer, { runId, timestamp, chunks: messages.length, stores: storeList.length });
  for (let i = 0; i < messages.length; i += 100) await queue.sendBatch(messages.slice(i, i + 100));
  log(`Started run ${runId} (${timestamp}): ${storeList.length} stores in ${messages.length} chunks.`);
  return { runId, timestamp, chunks: messages.length };
}

export async function processChunk(body, deps) {
  const { bucket, queue, fetch, sleep } = deps;
  const k = keys(body.prefix);
  if (!(await isCurrentRun(bucket, k, body.runId))) return { skipped: true };

  const { stores } = body;
  const found = new Map();
  const statuses = {};
  let pending = stores.map((_, i) => i);
  let budget = FETCH_BUDGET;

  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS && pending.length && budget > 0; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    const batch = pending.slice(0, budget);
    budget -= batch.length;
    const outcomes = await mapLimit(batch, CONCURRENCY, async (i) => {
      await sleep(200 + Math.random() * 300);
      return [i, await fetchStorePrices(fetch, stores[i].w)];
    });
    pending = pending.slice(batch.length);
    for (const [i, res] of outcomes) {
      tally(statuses, res.status);
      if (res.prices) found.set(i, res.prices);
      else pending.push(i);
    }
  }

  const prices = {};
  const candidates = [];
  stores.forEach((st, i) => {
    const got = found.get(i);
    if (!got) return;
    if (hasBaseline(st.last) && differsFrom(got, st.last)) candidates.push({ ...st, first: got });
    else (prices[st.s] ||= {})[st.c] = got;
  });

  const verifies = [];
  for (let i = 0; i < candidates.length; i += VERIFY_GROUP) {
    verifies.push({ body: { type: "verify", prefix: body.prefix, runId: body.runId, id: `${body.index}-${verifies.length}`, stores: candidates.slice(i, i + VERIFY_GROUP) } });
  }
  if (verifies.length) await queue.sendBatch(verifies);

  const failed = stores.filter((_, i) => !found.has(i)).map((st) => [st.s, st.c]);
  await putJson(bucket, `${k.run(body.runId)}p1-${body.index}-v${verifies.length}.json`, { prices, failed, statuses, candidates: candidates.length });
  const finalized = await finalizeIfComplete(deps, body.runId);
  return { fetched: found.size, failed: failed.length, candidates: candidates.length, statuses, finalized: finalized?.status };
}

export async function processVerify(body, deps) {
  const { bucket, fetch, sleep } = deps;
  const k = keys(body.prefix);
  if (!(await isCurrentRun(bucket, k, body.runId))) return { skipped: true };

  const statuses = {};
  const maxFetches = Math.max(6, Math.floor(FETCH_BUDGET / body.stores.length));
  const results = await mapLimit(body.stores, CONCURRENCY, async (st) => {
    const refetch = async () => {
      await sleep(2000 + Math.random() * 2000);
      const res = await fetchStorePrices(fetch, st.w);
      tally(statuses, res.status);
      return res.prices;
    };
    const outcome = await confirmOrRevert(st.first, st.last, refetch, { maxFetches });
    return { st, ...outcome };
  });

  const prices = {};
  const unconfirmed = [];
  const changes = [];
  for (const { st, prices: final, unconfirmed: flagged, samples } of results) {
    (prices[st.s] ||= {})[st.c] = final;
    if (flagged) unconfirmed.push({ store: [st.s, st.c], last: st.last, first: st.first, samples });
    else if (differsFrom(final, st.last)) changes.push({ store: [st.s, st.c], from: st.last, to: final });
  }
  await putJson(bucket, `${k.run(body.runId)}v-${body.id}.json`, { prices, unconfirmed, changes, statuses });
  const finalized = await finalizeIfComplete(deps, body.runId);
  return { confirmed: changes.length, unconfirmed: unconfirmed.length, finalized: finalized?.status };
}

// Prices in effect TREND_LOOKBACK_HOURS before `timestamp`, moved forward from the baseline
// the last run saved by applying the history entries in between.
async function trendBaseline(bucket, k, info, latest, timestamp, log) {
  if (!latest) return { previous: {}, previousTimestamp: null };
  const prev = latest.previous;
  const prevTs = latest.previous_timestamp;
  if (!prev || !prevTs || !info || info.empty) {
    return { previous: latest.prices || {}, previousTimestamp: latest.timestamp ?? null };
  }
  const target = shiftTimestamp(timestamp, -TREND_LOOKBACK_HOURS);
  if (!target || prevTs >= target) return { previous: prev, previousTimestamp: prevTs };

  const entries = await readEntriesBetween(bucket, k.history, info.size, prevTs, target);
  if (entries === null) {
    log(`Trend baseline ${prevTs} is too far back to move forward cheaply; keeping it.`);
    return { previous: prev, previousTimestamp: prevTs };
  }
  return { previous: applyEntries(prev, entries), previousTimestamp: target };
}

// Saves one validated, carried-forward snapshot: appends changed stores to the history and
// writes the latest file. The history is written first, so a failure part-way leaves at
// worst a repeated (harmless) history entry next hour, never a missing one.
export async function saveSnapshot({ bucket, prefix = "", timestamp, prices, latest, now = () => new Date(), log = console.log }) {
  const k = keys(prefix);
  if (latest?.timestamp && timestamp <= latest.timestamp) {
    log(`Timestamp ${timestamp} is not after the last save (${latest.timestamp}), likely the daylight-saving fall-back hour. Skipping this run's save.`);
    return { saved: false, reason: "not-newer" };
  }

  const info = await inspectHistory(bucket, k.history); // throws if the history is unreadable
  const { previous, previousTimestamp } = await trendBaseline(bucket, k, info, latest, timestamp, log);

  let changed;
  if (!info || info.empty) {
    await seedHistory(bucket, k.history, timestamp, prices, info?.empty ? { etagMatches: info.etag } : undefined);
    changed = countStores(prices);
    log(`Saved initial history snapshot -> ${k.history}`);
  } else {
    if (!latest?.prices) log(`${k.latest} is missing; recording every store as changed.`);
    const deltas = computePriceDeltas(prices, latest?.prices || {});
    changed = countStores(deltas);
    if (changed) {
      await appendHistory(bucket, k.history, info, timestamp, deltas);
      log(`Appended ${changed} store price change(s) -> ${k.history}`);
    } else {
      log(`No price changes. ${k.history} left untouched.`);
    }
  }

  await putJson(bucket, k.latest, {
    timestamp,
    prices,
    previous: sortStores(previous),
    previous_timestamp: previousTimestamp,
  }, LATEST_METADATA);

  if (changed) {
    const day = now().toISOString().slice(0, 10);
    await copyObject(bucket, k.history, k.backup(day), { contentType: "application/json", cacheControl: "public, max-age=86400" });
  }
  return { saved: true, changed };
}

// Saves the run. `early` is the call made when the last message finishes; without it (the
// :10 cron) a claim older than STALE_CLAIM_MS is taken over, in case that call crashed.
const STALE_CLAIM_MS = 5 * 60 * 1000;

export async function finalizeRun({ bucket, storeList, prefix = "", runId, early = false, now = () => new Date(), log = console.log }) {
  const k = keys(prefix);
  const pointer = await claimRun(bucket, k, { runId, staleAfterMs: early ? Infinity : STALE_CLAIM_MS, now });
  if (!pointer) {
    if (!early) log("No run to finalize (already saved, or another step is saving it).");
    return { status: "no-run" };
  }

  const runKeys = await listKeys(bucket, k.run(pointer.runId));
  const fetched = {};
  const verified = {};
  const failed = [];
  const unconfirmed = [];
  const changes = [];
  const statuses = {};
  let chunksDone = 0;
  let candidates = 0;
  for (const key of runKeys) {
    const part = await readJson(bucket, key);
    if (!part) continue;
    const name = key.slice(key.lastIndexOf("/") + 1);
    for (const [st, n] of Object.entries(part.statuses || {})) statuses[st] = (statuses[st] || 0) + n;
    const target = name.startsWith("v-") ? verified : fetched;
    for (const [state, cities] of Object.entries(part.prices || {})) Object.assign((target[state] ||= {}), cities);
    if (CHUNK_RESULT.test(name)) {
      chunksDone++;
      candidates += part.candidates || 0;
      failed.push(...(part.failed || []));
    } else {
      unconfirmed.push(...(part.unconfirmed || []));
      changes.push(...(part.changes || []));
    }
  }
  for (const [state, cities] of Object.entries(verified)) Object.assign((fetched[state] ||= {}), cities);

  const summary = {
    run: pointer.runId, timestamp: pointer.timestamp, finalizedBy: early ? "last message" : "cron backstop",
    chunksDone, chunks: pointer.chunks,
    storesFetched: countStores(fetched), stores: storeList.length, statuses,
    priceChanges: changes, unconfirmed, failedStores: failed.map(([s, c]) => `${c}, ${s}`),
    unverifiedCandidates: candidates - changes.length - unconfirmed.length,
  };

  try {
    const locations = locationsFrom(storeList);
    const check = validateSnapshot(fetched, locations);
    if (!check.ok) {
      log(JSON.stringify({ ...summary, result: "rejected", reason: check.reason }));
      return { status: "rejected", reason: check.reason, summary };
    }

    const latest = await readJson(bucket, k.latest);
    const { merged, carried } = carryForwardMissing(fetched, latest?.prices || {}, locations);
    const saved = await saveSnapshot({ bucket, prefix, timestamp: pointer.timestamp, prices: merged, latest, now, log });
    log(JSON.stringify({ ...summary, result: saved.saved ? "saved" : saved.reason, coverage: check.reason, carriedForward: carried, historyChanges: saved.changed ?? 0 }));
    return { status: saved.saved ? "saved" : saved.reason, summary };
  } finally {
    await deleteRun(bucket, k, pointer.runId);
    await bucket.delete(k.pointer);
  }
}
