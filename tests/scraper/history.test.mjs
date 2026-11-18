import { test } from "node:test";
import assert from "node:assert/strict";
import { appendHistory, HistoryUnreadableError, inspectHistory, readEntriesBetween, seedHistory } from "../../scraper/history.js";
import { FakeBucket, pythonHistory } from "./fakes.mjs";

const KEY = "us_history.json";
const entries = {
  "2026-06-30 09:00": { CA: { Tracy: [4.39, 4.79, null], Turlock: [4.5, 4.9, null] } },
  "2026-06-30 16:00": { CA: { Turlock: [4.45, 4.85, null] } },
};

test("appending to a Python-written history keeps it valid and in the same format", async () => {
  const bucket = new FakeBucket({ [KEY]: pythonHistory(entries) });
  const info = await inspectHistory(bucket, KEY);
  assert.equal(info.lastTimestamp, "2026-06-30 16:00");
  await appendHistory(bucket, KEY, info, "2026-07-01 08:00", { TX: { Austin: [2.99, 3.39, 3.49] } });

  const expected = { ...entries, "2026-07-01 08:00": { TX: { Austin: [2.99, 3.39, 3.49] } } };
  assert.deepEqual(bucket.json(KEY), expected);
  assert.equal(bucket.text(KEY), pythonHistory(expected));
});

test("an entry line longer than the first tail probe is still found", async () => {
  const big = {};
  for (let i = 0; i < 4000; i++) big[`City ${i} with a long name`] = [4.123, 4.567, 4.891];
  const bucket = new FakeBucket({ [KEY]: pythonHistory({ ...entries, "2026-07-01 00:00": { CA: big } }) });
  const info = await inspectHistory(bucket, KEY);
  assert.equal(info.lastTimestamp, "2026-07-01 00:00");
  await appendHistory(bucket, KEY, info, "2026-07-01 01:00", { CA: { Tracy: [1, 2, null] } });
  assert.equal(Object.keys(bucket.json(KEY)).length, 4);
});

test("a truncated history is reported as unreadable", async () => {
  const text = pythonHistory(entries);
  const bucket = new FakeBucket({ [KEY]: text.slice(0, text.length - 20) });
  await assert.rejects(inspectHistory(bucket, KEY), HistoryUnreadableError);
});

test("a history whose last line is broken JSON is reported as unreadable", async () => {
  const bucket = new FakeBucket({ [KEY]: '{\n  "2026-06-30 09:00": {"CA":{"A":[1,2,]}}\n}\n' });
  await assert.rejects(inspectHistory(bucket, KEY), HistoryUnreadableError);
});

test("missing, empty and {} histories", async () => {
  const bucket = new FakeBucket({ empty: "", braces: "{\n}\n" });
  assert.equal(await inspectHistory(bucket, KEY), null);
  assert.equal((await inspectHistory(bucket, "empty")).empty, true);
  assert.equal((await inspectHistory(bucket, "braces")).empty, true);
  await seedHistory(bucket, KEY, "2026-07-01 08:00", { CA: { A: [1, 2, 3] } });
  assert.deepEqual(bucket.json(KEY), { "2026-07-01 08:00": { CA: { A: [1, 2, 3] } } });
});

test("an append refuses to overwrite a history that changed in the meantime", async () => {
  const bucket = new FakeBucket({ [KEY]: pythonHistory(entries) });
  const info = await inspectHistory(bucket, KEY);
  bucket.set(KEY, pythonHistory({ ...entries, "2026-06-30 17:00": { CA: { Tracy: [1, 1, null] } } }));
  await assert.rejects(appendHistory(bucket, KEY, info, "2026-07-01 08:00", { CA: { A: [1, 1, 1] } }), /changed during this run/);
  assert.equal(Object.keys(bucket.json(KEY)).length, 3);
});

test("readEntriesBetween returns the entries in the window, oldest first", async () => {
  const many = {};
  for (let h = 0; h < 24; h++) many[`2026-07-01 ${String(h).padStart(2, "0")}:00`] = { CA: { A: [h, h, h] } };
  const text = pythonHistory(many);
  const bucket = new FakeBucket({ [KEY]: text });
  const got = await readEntriesBetween(bucket, KEY, text.length, "2026-07-01 05:00", "2026-07-01 08:00");
  assert.deepEqual(got.map((e) => e.CA.A[0]), [6, 7, 8]);
});
