// Serves price snapshots (us_latest.json, us_history.json, ...) from the R2 bucket.
// Shared by the Pages middleware (functions/_middleware.js) and the standalone
// Worker (worker.js). Lives outside public/ and functions/ so it is neither served
// as a static file nor treated as a Pages route.

export function isSnapshotPath(pathname) {
  return pathname.endsWith("_latest.json") || pathname.endsWith("_history.json");
}

function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export async function serveSnapshot(pathname, bucket) {
  if (!bucket) {
    return jsonError(
      500,
      "DATA_BUCKET binding is missing. Add it under Settings > Functions > R2 bucket bindings (Pages) or in wrangler.jsonc (Worker)."
    );
  }

  const key = pathname.replace(/^\/+/, "");
  try {
    const object = await bucket.get(key);
    if (!object) return jsonError(404, `File '${key}' not found in R2 bucket`);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Content-Type", "application/json");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("X-Data-Source", "Cloudflare-R2");
    headers.set("Cache-Control", key.includes("latest") ? "public, max-age=300" : "public, max-age=3600");
    return new Response(object.body, { headers });
  } catch (err) {
    console.error(`Error fetching ${key} from R2:`, err);
    return jsonError(500, `R2 fetch error: ${err.message}`);
  }
}
