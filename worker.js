export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Route dynamic JSON data files through R2 bucket
    if (
      pathname.endsWith("_latest.json") ||
      pathname.endsWith("_history.json") ||
      pathname.endsWith("_freq_latest.json") ||
      pathname.endsWith("_freq_history.json")
    ) {
      const key = pathname.replace(/^\/+/, "");
      try {
        const object = await env.DATA_BUCKET.get(key);
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
        console.error(`Error fetching ${key} from R2:`, err);
      }
    }

    // Fall back to static assets (index.html, styles.css, app.js, us_stores.json, etc.)
    return env.ASSETS.fetch(request);
  },
};
