// Cloudflare Worker that runs the hourly price scrape (see run.js for the steps).
// Deployed separately from the site: npx wrangler deploy -c scraper/wrangler.jsonc
//
// Settings (scraper/wrangler.jsonc "vars"):
//   WRITE_PREFIX  "" writes the live us_latest.json / us_history.json. Any other value (e.g.
//                 "worker-test/") is shadow mode: the Worker keeps its own copies under that
//                 prefix, starting from the live files, so it can run next to another scraper.
//   ENABLE_PROBE  "1" turns on GET /probe, which fetches a few stores and reports what Costco
//                 returned (to check Costco answers requests from Cloudflare).
// Secret (optional): RUN_TOKEN enables POST /run?step=start|finalize with
//   "Authorization: Bearer <token>", to run a step without waiting for the cron.
import usStores from "../public/us_stores.json" with { type: "json" };
import { fetchStorePrices } from "./costco.js";
import { compactStores, finalizeRun, processChunk, processVerify, startRun } from "./run.js";

const FINALIZE_CRON = "10 * * * *";
const PROBE_STORES = 6;

let storeList;
function stores() {
  storeList ??= compactStores(usStores);
  return storeList;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deps(env) {
  return {
    bucket: env.DATA_BUCKET,
    queue: env.SCRAPE_QUEUE,
    prefix: env.WRITE_PREFIX ?? "",
    storeList: stores(),
    fetch: (url, init) => fetch(url, init),
    sleep,
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

async function probe() {
  // One store from each of the first few states.
  const seen = new Set();
  const picks = stores().filter((st) => !seen.has(st.s) && seen.add(st.s)).slice(0, PROBE_STORES);
  const results = await Promise.all(picks.map(async (st) => ({ store: `${st.c}, ${st.s}`, ...(await fetchStorePrices(fetch, st.w)) })));
  const ok = results.filter((r) => r.prices).length;
  return { verdict: ok ? `Costco answered ${ok}/${results.length} requests` : "Costco returned no prices - requests from Cloudflare may be blocked", results };
}

async function status(env) {
  const d = deps(env);
  const pointer = await d.bucket.get(`${d.prefix}runs/us/current.json`);
  const latest = await d.bucket.head(`${d.prefix}us_latest.json`);
  return {
    mode: d.prefix ? `shadow (writing under "${d.prefix}")` : "live",
    stores: d.storeList.length,
    runInProgress: pointer ? await pointer.json() : null,
    latestUploaded: latest?.uploaded ?? null,
  };
}

export default {
  async scheduled(event, env) {
    if (event.cron === FINALIZE_CRON) await finalizeRun(deps(env));
    else await startRun(deps(env));
  },

  async queue(batch, env) {
    const d = deps(env);
    for (const msg of batch.messages) {
      try {
        const body = msg.body;
        const result = body.type === "verify" ? await processVerify(body, d) : await processChunk(body, d);
        console.log(JSON.stringify({ step: body.type, run: body.runId, part: body.index ?? body.id, ...result }));
        msg.ack();
      } catch (e) {
        console.error(`Queue message failed: ${e?.stack || e}`);
        msg.retry();
      }
    }
  },

  async fetch(request, env, ctx) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/status" && request.method === "GET") return json(await status(env));
    if (pathname === "/probe" && request.method === "GET" && env.ENABLE_PROBE === "1") return json(await probe());
    if (pathname === "/run" && request.method === "POST" && env.RUN_TOKEN) {
      if (request.headers.get("Authorization") !== `Bearer ${env.RUN_TOKEN}`) return json({ error: "unauthorized" }, 401);
      const step = searchParams.get("step");
      if (step === "start") return json(await startRun(deps(env)));
      if (step === "finalize") {
        ctx.waitUntil(finalizeRun(deps(env)));
        return json({ finalizing: true, note: "see the Worker's logs for the result" });
      }
      return json({ error: "step must be start or finalize" }, 400);
    }
    return json({ error: "not found" }, 404);
  },
};
