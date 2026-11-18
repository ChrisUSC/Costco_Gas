// In-memory stand-ins for the Workers bindings the scraper uses (R2 bucket, queue) and for
// Costco's price endpoint, so the scraper tests need no network or Cloudflare account.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function toBytes(value) {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ReadableStream) {
    const chunks = [];
    const reader = value.getReader();
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }
  throw new Error(`fake R2 can't store ${typeof value}`);
}

function body(bytes, etag) {
  return {
    size: bytes.length,
    etag,
    body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
    text: async () => decoder.decode(bytes),
    json: async () => JSON.parse(decoder.decode(bytes)),
  };
}

export class FakeBucket {
  constructor(files = {}) {
    this.objects = new Map();
    this.version = 0;
    this.puts = [];
    for (const [key, text] of Object.entries(files)) this.set(key, text);
  }

  set(key, text) {
    this.objects.set(key, { bytes: encoder.encode(text), etag: `e${++this.version}`, meta: {} });
  }

  text(key) {
    const o = this.objects.get(key);
    return o ? decoder.decode(o.bytes) : null;
  }

  json(key) {
    const t = this.text(key);
    return t === null ? null : JSON.parse(t);
  }

  async head(key) {
    const o = this.objects.get(key);
    return o ? { key, size: o.bytes.length, etag: o.etag, uploaded: new Date(0) } : null;
  }

  async get(key, opts = {}) {
    const o = this.objects.get(key);
    if (!o) return null;
    let bytes = o.bytes;
    if (opts.range) {
      const { offset = 0, length } = opts.range;
      bytes = bytes.slice(offset, length === undefined ? undefined : offset + length);
    }
    return body(bytes, o.etag);
  }

  async put(key, value, opts = {}) {
    const bytes = await toBytes(value);
    const cur = this.objects.get(key);
    if (opts.onlyIf?.etagMatches && cur?.etag !== opts.onlyIf.etagMatches) return null;
    const etag = `e${++this.version}`;
    this.objects.set(key, { bytes, etag, meta: opts.httpMetadata || {} });
    this.puts.push(key);
    return { key, etag };
  }

  async delete(keys) {
    for (const key of [].concat(keys)) this.objects.delete(key);
  }

  async list({ prefix = "" } = {}) {
    const objects = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key }));
    return { objects, truncated: false };
  }
}

export class FakeQueue {
  constructor() { this.messages = []; }
  async sendBatch(batch) { this.messages.push(...batch.map((m) => m.body)); }
  take() { const out = this.messages; this.messages = []; return out; }
}

// fetch() stand-in for Costco's endpoint. `answer(warehouseId, callNumber)` returns a price
// array, null (empty reply), or a number (HTTP status). Counts requests per invocation.
export function fakeCostco(answer) {
  const calls = new Map();
  const fake = async (url) => {
    fake.requests++;
    const id = new URL(url).searchParams.get("warehouseid");
    const n = (calls.get(id) || 0) + 1;
    calls.set(id, n);
    const result = answer(id, n);
    if (typeof result === "number") return new Response("blocked", { status: result });
    const [regular, premium, diesel] = result || [null, null, null];
    const fmt = (v) => (v === null ? "" : String(v));
    return Response.json({ [id]: { Regular: fmt(regular), Premium: fmt(premium), Diesel: fmt(diesel) } });
  };
  fake.requests = 0;
  return fake;
}

// The history format pipeline/scraper.py writes (write_pretty_top_level).
export function pythonHistory(entries) {
  const lines = Object.entries(entries).map(([ts, v]) => `  ${JSON.stringify(ts)}: ${JSON.stringify(v)}`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

export const noSleep = async () => {};
