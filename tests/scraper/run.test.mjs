import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHUNK_SIZE, compactStores, finalizeRun, processChunk, processVerify, startRun } from "../../scraper/run.js";
import { FakeBucket, FakeQueue, fakeCostco, noSleep, pythonHistory } from "./fakes.mjs";

const NOW = () => new Date("2026-07-04T17:00:00Z"); // 2026-07-04 10:00 Pacific
const RUN_TS = "2026-07-04 10:00";
const quiet = () => {};

// 30 stores over 6 states (2 chunks), each with a distinct price.
const storeList = [];
const basePrices = {};
for (let s = 0; s < 6; s++) {
  const state = `S${s}`;
  for (let c = 0; c < 5; c++) {
    const w = String(100 + s * 10 + c);
    storeList.push({ s: state, c: `City${c}`, w });
    (basePrices[state] ||= {})[`City${c}`] = [3 + s / 10, 3.5 + c / 10, null];
  }
}
const byId = Object.fromEntries(storeList.map((st) => [st.w, basePrices[st.s][st.c]]));

function setup({ latest = {}, history } = {}) {
  const firstTs = "2026-06-01 00:00";
  return new FakeBucket({
    "us_latest.json": JSON.stringify({ timestamp: "2026-07-04 09:00", prices: basePrices, previous: basePrices, previous_timestamp: "2026-07-01 09:00", ...latest }),
    "us_history.json": history ?? pythonHistory({ [firstTs]: basePrices }),
  });
}

// Runs one hour: start, then every queued chunk/verify message (the last one saves the run),
// then the :10 cron backstop. Returns the save result, whichever step made it.
async function runHour(bucket, answer, { prefix = "", perInvocation, drop = () => false, stores = storeList } = {}) {
  const queue = new FakeQueue();
  const fetch = fakeCostco(answer);
  const deps = { bucket, queue, fetch, sleep: noSleep, storeList: stores, prefix, now: NOW, log: quiet };
  await startRun(deps);
  let early;
  const saves = [];
  const log = (line) => { if (line.startsWith("{")) saves.push(JSON.parse(line)); };
  for (let msgs = queue.take(); msgs.length; msgs = queue.take()) {
    for (const body of msgs) {
      if (drop(body)) continue;
      fetch.requests = 0;
      const out = await (body.type === "verify" ? processVerify(body, { ...deps, log }) : processChunk(body, { ...deps, log }));
      perInvocation?.push(fetch.requests);
      if (out.finalized) early = { status: out.finalized, summary: saves.at(-1) };
    }
  }
  const backstop = await finalizeRun({ ...deps, log });
  if (early && backstop.status !== "no-run") throw new Error("run was saved twice");
  return early ?? backstop;
}

test("an hour with no price changes updates the timestamp and leaves history alone", async () => {
  const bucket = setup();
  const before = bucket.text("us_history.json");
  const res = await runHour(bucket, (id) => byId[id]);
  assert.equal(res.status, "saved");
  const latest = bucket.json("us_latest.json");
  assert.equal(latest.timestamp, RUN_TS);
  assert.deepEqual(latest.prices, basePrices);
  assert.equal(bucket.text("us_history.json"), before);
  assert.deepEqual(await bucket.list({ prefix: "runs/" }), { objects: [], truncated: false });
});

test("a confirmed price change is appended to history and backed up", async () => {
  const bucket = setup();
  const res = await runHour(bucket, (id) => (id === "123" ? [3.99, 4.49, null] : byId[id]));
  assert.equal(res.status, "saved");
  assert.equal(res.summary.priceChanges.length, 1);
  const history = bucket.json("us_history.json");
  assert.deepEqual(history[RUN_TS], { S2: { City3: [3.99, 4.49, null] } });
  assert.deepEqual(bucket.json("us_latest.json").prices.S2.City3, [3.99, 4.49, null]);
  assert.deepEqual(bucket.json("backups/us_history_2026-07-04.json"), history);
});

test("a reading that never settles is not confirmed and reverts to the last known price", async () => {
  const bucket = setup();
  const before = bucket.text("us_history.json");
  const res = await runHour(bucket, (id, n) => (id === "123" ? (n === 1 ? [9.99, 9.99, null] : [n, n, null]) : byId[id]));
  assert.equal(res.summary.unconfirmed.length, 1);
  assert.equal(res.summary.priceChanges.length, 0);
  assert.deepEqual(bucket.json("us_latest.json").prices.S2.City3, basePrices.S2.City3);
  assert.equal(bucket.text("us_history.json"), before);
});

test("a one-off odd reading that rechecks back to the old price changes nothing", async () => {
  const bucket = setup();
  const before = bucket.text("us_history.json");
  const res = await runHour(bucket, (id, n) => (id === "123" && n === 1 ? [9.99, 9.99, null] : byId[id]));
  assert.equal(res.summary.unconfirmed.length, 0);
  assert.equal(res.summary.priceChanges.length, 0);
  assert.equal(bucket.text("us_history.json"), before);
});

test("if Costco blocks the requests nothing is saved", async () => {
  const bucket = setup();
  const latestBefore = bucket.text("us_latest.json");
  const res = await runHour(bucket, () => 403);
  assert.equal(res.status, "rejected");
  assert.deepEqual(Object.keys(res.summary.statuses), ["403"]);
  assert.equal(bucket.text("us_latest.json"), latestBefore);
});

test("a few failing stores keep their last known price", async () => {
  const bucket = setup();
  const res = await runHour(bucket, (id) => (id === "100" || id === "151" ? 503 : byId[id]));
  assert.equal(res.status, "saved");
  assert.equal(res.summary.failedStores.length, 2);
  assert.deepEqual(bucket.json("us_latest.json").prices, basePrices);
});

test("no invocation makes more than 50 outbound requests, even when every fetch fails", async () => {
  const counts = [];
  await runHour(setup(), () => 500, { perInvocation: counts });
  assert.ok(counts.length >= Math.ceil(storeList.length / CHUNK_SIZE));
  assert.ok(Math.max(...counts) <= 50, `max ${Math.max(...counts)}`);

  const flaky = [];
  await runHour(setup(), (id, n) => (n === 1 ? byId[id] : [n, n, n]), { perInvocation: flaky }); // every store "changes" and never settles
  assert.ok(Math.max(...flaky) <= 50, `max ${Math.max(...flaky)}`);
});

test("shadow mode starts from the live files and never writes them", async () => {
  const bucket = setup();
  const live = { latest: bucket.text("us_latest.json"), history: bucket.text("us_history.json") };
  const res = await runHour(bucket, (id) => (id === "123" ? [3.99, 4.49, null] : byId[id]), { prefix: "worker-test/" });
  assert.equal(res.status, "saved");
  assert.equal(bucket.text("us_latest.json"), live.latest);
  assert.equal(bucket.text("us_history.json"), live.history);
  assert.equal(bucket.json("worker-test/us_latest.json").timestamp, RUN_TS);
  assert.deepEqual(bucket.json("worker-test/us_history.json")[RUN_TS], { S2: { City3: [3.99, 4.49, null] } });
  assert.ok(!bucket.puts.some((k) => !k.startsWith("worker-test/")));
});

test("the 72-hour trend baseline moves forward using history entries", async () => {
  const history = pythonHistory({
    "2026-06-01 00:00": basePrices,
    "2026-07-01 09:30": { S0: { City0: [2.5, 3.0, null] } }, // between old baseline and target
    "2026-07-01 10:30": { S0: { City0: [2.6, 3.1, null] } }, // after the target: not applied
  });
  const bucket = setup({ history });
  await runHour(bucket, (id) => byId[id]);
  const latest = bucket.json("us_latest.json");
  assert.equal(latest.previous_timestamp, "2026-07-01 10:00");
  assert.deepEqual(latest.previous.S0.City0, [2.5, 3.0, null]);
  assert.deepEqual(latest.previous.S1, basePrices.S1);
});

test("a run whose timestamp isn't newer than the last save (DST fall-back) is skipped", async () => {
  const bucket = setup({ latest: { timestamp: "2026-07-04 10:00" } });
  const before = bucket.text("us_latest.json");
  const res = await runHour(bucket, (id) => byId[id]);
  assert.equal(res.status, "not-newer");
  assert.equal(bucket.text("us_latest.json"), before);
});

test("an unreadable history stops the save", async () => {
  const bucket = setup({ history: '{\n  "2026-06-01 00:00": {"S0":' });
  const latestBefore = bucket.text("us_latest.json");
  await assert.rejects(runHour(bucket, (id) => byId[id]), /truncated|unexpected/);
  assert.equal(bucket.text("us_latest.json"), latestBefore);
  assert.equal(bucket.text("us_history.json"), '{\n  "2026-06-01 00:00": {"S0":');
});

test("chunk messages for a finished run are ignored", async () => {
  const bucket = setup();
  const queue = new FakeQueue();
  const deps = { bucket, queue, fetch: fakeCostco((id) => byId[id]), sleep: noSleep, storeList, now: NOW, log: quiet };
  await startRun(deps);
  const [first] = queue.take();
  await finalizeRun(deps);
  assert.deepEqual(await processChunk(first, deps), { skipped: true });
});

test("the real store list fits in queue messages", () => {
  const list = compactStores(JSON.parse(readFileSync(new URL("../../public/us_stores.json", import.meta.url))));
  assert.ok(list.length > 500);
  assert.ok(list.every((st) => st.s && st.c && /^\d+$/.test(st.w)));
  const message = JSON.stringify({ stores: list.slice(0, CHUNK_SIZE).map((st) => ({ ...st, last: [9.999, 9.999, 9.999] })) });
  assert.ok(message.length < 128 * 1024);
});

test("the last message to finish saves the run; the :10 cron then has nothing to do", async () => {
  const bucket = setup();
  const res = await runHour(bucket, (id) => (id === "123" ? [3.99, 4.49, null] : byId[id]));
  assert.equal(res.status, "saved");
  assert.equal(res.summary.finalizedBy, "last message");
  assert.equal(bucket.puts.filter((k) => k === "us_latest.json").length, 1);
  assert.deepEqual(bucket.json("us_history.json")[RUN_TS], { S2: { City3: [3.99, 4.49, null] } });
});

test("if a chunk never finishes, the :10 cron still finalizes the run", async () => {
  const bucket = setup();
  const latestBefore = bucket.text("us_latest.json");
  // With 30 test stores, one missing chunk is a third of them: below the 75% store threshold.
  const res = await runHour(bucket, (id) => byId[id], { drop: (body) => body.type === "chunk" && body.index === 1 });
  assert.equal(res.summary.finalizedBy, "cron backstop");
  assert.equal(res.status, "rejected");
  assert.equal(bucket.text("us_latest.json"), latestBefore);
  assert.deepEqual((await bucket.list({ prefix: "runs/" })).objects, []);
});

test("if a verify message never finishes, the changed store keeps its old price", async () => {
  const bucket = setup();
  const res = await runHour(bucket, (id) => (id === "123" ? [3.99, 4.49, null] : byId[id]), { drop: (body) => body.type === "verify" });
  assert.equal(res.summary.finalizedBy, "cron backstop");
  assert.deepEqual(bucket.json("us_latest.json").prices.S2.City3, basePrices.S2.City3);
});

test("only one caller can claim a run", async () => {
  const bucket = setup();
  const deps = { bucket, queue: new FakeQueue(), storeList, now: NOW, log: quiet };
  await startRun(deps);
  const [a, b] = await Promise.all([finalizeRun(deps), finalizeRun(deps)]);
  assert.deepEqual([a.status, b.status].sort(), ["no-run", "rejected"]);
});

test("the cron takes over a claim left by a finalize that crashed", async () => {
  const bucket = setup();
  const deps = { bucket, queue: new FakeQueue(), fetch: fakeCostco((id) => byId[id]), sleep: noSleep, storeList, now: NOW, log: quiet };
  await startRun(deps);
  const msgs = deps.queue.take();
  const pointer = bucket.json("runs/us/current.json");
  for (const body of msgs.slice(0, -1)) await processChunk(body, deps);
  bucket.set("runs/us/current.json", JSON.stringify({ ...pointer, finalizing: "2026-07-04T17:01:00Z" }));
  await processChunk(msgs.at(-1), deps); // claimed already: skipped
  const later = { ...deps, now: () => new Date("2026-07-04T17:10:00Z") };
  const res = await finalizeRun(later);
  assert.notEqual(res.status, "no-run");
  const fresh = { ...deps, now: () => new Date("2026-07-04T17:03:00Z") };
  await startRun(fresh);
  bucket.set("runs/us/current.json", JSON.stringify({ ...bucket.json("runs/us/current.json"), finalizing: "2026-07-04T17:02:00Z" }));
  assert.equal((await finalizeRun(fresh)).status, "no-run"); // a recent claim is left alone
});

test("R2 operations per hour stay far inside the free allowance", async () => {
  // 600 stores (about the real list) with a handful of price changes.
  const stores = [];
  const prices = {};
  for (let i = 0; i < 600; i++) {
    const st = { s: `S${i % 50}`, c: `City${i}`, w: String(1000 + i) };
    stores.push(st);
    (prices[st.s] ||= {})[st.c] = [3 + (i % 90) / 100, 4, null];
  }
  const price = Object.fromEntries(stores.map((st) => [st.w, prices[st.s][st.c]]));
  const bucket = new FakeBucket({
    "us_latest.json": JSON.stringify({ timestamp: "2026-07-04 09:00", prices, previous: prices, previous_timestamp: "2026-07-01 09:00" }),
    "us_history.json": pythonHistory({ "2026-06-01 00:00": prices }),
  });
  let classA = 0;
  for (const m of ["put", "list"]) {
    const orig = bucket[m].bind(bucket);
    bucket[m] = (...a) => { classA++; return orig(...a); };
  }
  const changed = new Set(["1003", "1100", "1250", "1400", "1599"]);
  const res = await runHour(bucket, (id) => (changed.has(id) ? [5, 5, null] : price[id]), { stores });
  assert.equal(res.status, "saved");
  // 720 runs a month against the free plan's 1,000,000 class A operations.
  assert.ok(classA * 720 < 100000, `${classA} per run = ${classA * 720} a month`);
  if (process.env.SHOW_R2_OPS) console.log(`R2 class A: ${classA} per run, ${classA * 720} a month`);
});
