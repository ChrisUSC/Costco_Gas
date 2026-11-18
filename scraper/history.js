// Change-only history in R2 (us_history.json), handled without ever parsing the whole file:
// the free Workers plan allows 10 ms of CPU per run, and the file is several MB.
//
// The file is written one entry per line (as pipeline/scraper.py's write_pretty_top_level does):
//   {
//     "2026-06-30 09:00": {"CA":{"Turlock":[4.5,4.9,null]}},
//     "2026-06-30 16:00": {"CA":{"Turlock":[4.45,4.85,null]}}
//   }
// so a new entry is appended by streaming the existing bytes up to the last entry and adding
// `,\n  "<ts>": {...}\n}\n`, and recent entries are read from a ranged read of the file's end.

const encoder = new TextEncoder();
const HISTORY_METADATA = { contentType: "application/json", cacheControl: "public, max-age=3600" };
const TAIL_PROBE_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const ENTRY_LINE = /^ {2}"([^"]+)": /;

export class HistoryUnreadableError extends Error {}

function byteLength(text) {
  return encoder.encode(text).length;
}

async function readRange(bucket, key, offset, length) {
  const obj = await bucket.get(key, { range: { offset, length } });
  if (!obj) throw new HistoryUnreadableError(`${key} disappeared while being read`);
  return obj.text();
}

function parseEntryLine(line) {
  const parsed = JSON.parse(`{${line.replace(/,\s*$/, "")}}`);
  const keys = Object.keys(parsed);
  if (keys.length !== 1) throw new Error("expected exactly one entry on the line");
  return [keys[0], parsed[keys[0]]];
}

// Checks the end of the history file and finds where a new entry goes.
// Returns null if the file doesn't exist, { empty: true, etag } for an empty file or "{}",
// or { etag, size, keepBytes, lastTimestamp }. Throws HistoryUnreadableError if the end of
// the file isn't a well-formed entry, so the caller stops instead of overwriting it.
export async function inspectHistory(bucket, key) {
  const head = await bucket.head(key);
  if (!head) return null;
  if (head.size === 0) return { empty: true, etag: head.etag };

  for (let probe = TAIL_PROBE_BYTES; ; probe *= 2) {
    const length = Math.min(probe, head.size);
    const offset = head.size - length;
    const text = await readRange(bucket, key, offset, length);

    const close = text.lastIndexOf("}");
    if (close === -1 || text.slice(close + 1).trim() !== "") {
      throw new HistoryUnreadableError(`${key} doesn't end with '}' - it may be truncated`);
    }
    const entryEnd = text.lastIndexOf("}", close - 1);
    if (entryEnd === -1 || text.slice(entryEnd + 1, close).trim() !== "") {
      if (offset === 0 && text.trim().replace(/\s+/g, "") === "{}") return { empty: true, etag: head.etag };
      throw new HistoryUnreadableError(`${key} has an unexpected ending`);
    }

    const lineStart = text.lastIndexOf("\n", entryEnd) + 1;
    const startsInChunk = lineStart > 0 || offset === 0;
    const line = text.slice(lineStart, entryEnd + 1);
    if (startsInChunk && ENTRY_LINE.test(line)) {
      let lastTimestamp;
      try {
        [lastTimestamp] = parseEntryLine(line);
      } catch (e) {
        throw new HistoryUnreadableError(`${key}: last entry isn't valid JSON (${e.message})`, { cause: e });
      }
      return { etag: head.etag, size: head.size, keepBytes: head.size - byteLength(text.slice(entryEnd + 1)), lastTimestamp };
    }
    if (offset === 0 || length >= MAX_TAIL_BYTES) {
      throw new HistoryUnreadableError(`${key}: couldn't find the last entry`);
    }
  }
}

// A stream of `head` followed by `tail`, with the known length R2 needs for a streamed put.
function concatStream(head, tail, total) {
  if (typeof FixedLengthStream === "function") {
    const { readable, writable } = new FixedLengthStream(total);
    head
      .pipeTo(writable, { preventClose: true })
      .then(async () => {
        const writer = writable.getWriter();
        if (tail.length) await writer.write(tail);
        await writer.close();
      })
      .catch(() => {}); // a failed pipe aborts `writable`, which fails the put
    return readable;
  }
  // Node (tests): no FixedLengthStream; the fake bucket reads the stream itself.
  return new ReadableStream({
    async start(controller) {
      const reader = head.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      if (tail.length) controller.enqueue(tail);
      controller.close();
    },
  });
}

function entryText(ts, delta) {
  return `  ${JSON.stringify(ts)}: ${JSON.stringify(delta)}`;
}

// Writes a new history holding just one full snapshot.
export async function seedHistory(bucket, key, ts, snapshot, onlyIf) {
  const res = await bucket.put(key, `{\n${entryText(ts, snapshot)}\n}\n`, {
    httpMetadata: HISTORY_METADATA,
    ...(onlyIf ? { onlyIf } : {}),
  });
  if (!res) throw new Error(`${key} changed during this run; not overwriting it`);
}

// Appends one entry. `info` comes from inspectHistory; the put only succeeds if the file
// hasn't changed since then (so two overlapping runs can't drop each other's entries).
export async function appendHistory(bucket, key, info, ts, delta) {
  const tail = encoder.encode(`,\n${entryText(ts, delta)}\n}\n`);
  const existing = await bucket.get(key, { range: { offset: 0, length: info.keepBytes } });
  if (!existing) throw new HistoryUnreadableError(`${key} disappeared while being appended to`);
  const res = await bucket.put(key, concatStream(existing.body, tail, info.keepBytes + tail.length), {
    httpMetadata: HISTORY_METADATA,
    onlyIf: { etagMatches: info.etag },
  });
  if (!res) throw new Error(`${key} changed during this run; not overwriting it`);
}

// Streams one R2 object to another key (used for the daily history backup).
export async function copyObject(bucket, from, to, httpMetadata) {
  const obj = await bucket.get(from);
  if (!obj) return false;
  await bucket.put(to, concatStream(obj.body, new Uint8Array(0), obj.size), { httpMetadata });
  return true;
}

// Returns the history entries with after < timestamp <= upTo, oldest first, read from the
// end of the file. Returns null if they aren't within the last MAX_TAIL_BYTES (the caller then
// keeps its old trend baseline rather than spending its CPU budget on the whole file).
export async function readEntriesBetween(bucket, key, size, after, upTo) {
  for (let probe = TAIL_PROBE_BYTES; ; probe *= 2) {
    const length = Math.min(probe, size, MAX_TAIL_BYTES);
    const offset = size - length;
    const lines = (await readRange(bucket, key, offset, length)).split("\n");
    if (offset > 0) lines.shift(); // probably cut mid-line

    const entries = [];
    let earliest = null;
    for (const line of lines) {
      const m = ENTRY_LINE.exec(line);
      if (!m) continue;
      const ts = m[1];
      earliest ??= ts;
      if (ts > after && ts <= upTo) entries.push(parseEntryLine(line)[1]);
    }
    if (offset === 0 || (earliest !== null && earliest <= after)) return entries;
    if (length >= MAX_TAIL_BYTES) return null;
  }
}
