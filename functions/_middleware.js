import { isSnapshotPath, serveSnapshot } from "../r2_snapshots.js";

export async function onRequest(context) {
  const { pathname } = new URL(context.request.url);
  if (isSnapshotPath(pathname)) return serveSnapshot(pathname, context.env?.DATA_BUCKET);

  // Everything else is a static asset (HTML, CSS, JS, us_stores.json)
  return context.next();
}
