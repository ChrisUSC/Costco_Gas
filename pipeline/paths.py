"""Central file locations for the data pipeline.

Paths are absolute (resolved from this file), so the scripts behave the same
whatever directory they are run from.
"""

import os

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Static site served by Cloudflare. us_stores.json lives here because the site fetches it.
PUBLIC_DIR = os.path.join(REPO_ROOT, "public")

# Store lists that only the pipeline uses.
DATA_DIR = os.path.join(REPO_ROOT, "data")

# Local working copies of the price snapshots kept in R2 (git-ignored).
SNAPSHOT_DIR = os.path.join(DATA_DIR, "snapshots")

US_STORES_FILE = os.path.join(PUBLIC_DIR, "us_stores.json")
CA_STORES_FILE = os.path.join(DATA_DIR, "ca_stores.json")
LOCAL_STORES_FILE = os.path.join(DATA_DIR, "local_stores.json")


def snapshot_path(name: str) -> str:
    """Local path for an R2 snapshot object, e.g. 'us_latest.json'."""
    return os.path.join(SNAPSHOT_DIR, name)
