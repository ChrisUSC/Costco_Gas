export async function onRequest(context) {
  const url = new URL(context.request.url);
  const pathname = url.pathname;

  // Route dynamic JSON data files through R2 bucket
  if (
    pathname.endsWith("_latest.json") ||
    pathname.endsWith("_history.json") ||
    pathname.endsWith("_freq_latest.json") ||
    pathname.endsWith("_freq_history.json")
  ) {
    const key = pathname.replace(/^\/+/, "");
    if (context.env && context.env.DATA_BUCKET) {
      try {
        const object = await context.env.DATA_BUCKET.get(key);
        if (object) {
          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set("etag", object.httpEtag);
          headers.set("Content-Type", "application/json");
          headers.set("Access-Control-Allow-Origin", "*");
          headers.set(
            "Cache-Control",
            key.includes("latest") ? "public, max-age=300" : "public, max-age=3600"
          );
          return new Response(object.body, { headers });
        }
      } catch (err) {
        console.error(`Error reading ${key} from R2 in Pages middleware:`, err);
      }
    }
  }

  // Fall back to static assets
  return context.next();
}
