import { isSnapshotPath, serveSnapshot } from "./r2_snapshots.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (isSnapshotPath(pathname)) return serveSnapshot(pathname, env.DATA_BUCKET);

    // Everything else is a static asset (index.html, styles.css, app.js, us_stores.json, ...)
    return env.ASSETS.fetch(request);
  },
};
