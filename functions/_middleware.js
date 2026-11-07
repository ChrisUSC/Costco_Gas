export async function onRequest(context) {
  const url = new URL(context.request.url);
  const pathname = url.pathname;

  // Route dynamic JSON data files strictly through R2 bucket
  if (
    pathname.endsWith("_latest.json") ||
    pathname.endsWith("_history.json") ||
    pathname.endsWith("_freq_latest.json") ||
    pathname.endsWith("_freq_history.json")
  ) {
    const key = pathname.replace(/^\/+/, "");

    if (!context.env || !context.env.DATA_BUCKET) {
      return new Response(
        JSON.stringify({
          error: "DATA_BUCKET binding is missing in Cloudflare Pages. Please add it under Settings > Functions > R2 bucket bindings.",
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    try {
      const object = await context.env.DATA_BUCKET.get(key);
      if (object) {
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Content-Type", "application/json");
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("X-Data-Source", "Cloudflare-R2");
        headers.set(
          "Cache-Control",
          key.includes("latest") ? "public, max-age=300" : "public, max-age=3600"
        );
        return new Response(object.body, { headers });
      }

      return new Response(
        JSON.stringify({ error: `File '${key}' not found in R2 bucket` }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `R2 fetch error: ${err.message}` }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  }

  // All other requests fall through to static assets (HTML, CSS, JS, us_stores.json)
  return context.next();
}
