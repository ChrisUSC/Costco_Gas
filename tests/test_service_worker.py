"""Every file the app loads must be in the service worker's precache list, or it would be
missing when the installed app is opened offline."""
import os
import re

PUBLIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")


def _sw_list(name: str) -> set[str]:
    with open(os.path.join(PUBLIC, "sw.js"), encoding="utf-8") as f:
        src = f.read()
    body = re.search(rf"const {name} = \[(.*?)\];", src, re.S).group(1)
    return set(re.findall(r"'([^']+)'", body))


def test_app_files_cover_every_module_icon_and_root_asset():
    # Root assets the app loads (data snapshots from R2 are in DATA_FILES instead).
    root = {n for n in os.listdir(PUBLIC)
            if os.path.isfile(os.path.join(PUBLIC, n))
            and n not in ("index.html", "sw.js", "us_stores.json")
            and not n.endswith(("_latest.json", "_history.json"))}
    expected = {"./"} | root
    expected |= {f"js/{n}" for n in os.listdir(os.path.join(PUBLIC, "js")) if n.endswith(".js")}
    expected |= {f"icons/{n}" for n in os.listdir(os.path.join(PUBLIC, "icons"))}
    missing = expected - _sw_list("APP_FILES")
    assert not missing, f"add these to APP_FILES in public/sw.js: {sorted(missing)}"


def test_app_files_all_exist():
    listed = _sw_list("APP_FILES") - {"./"}
    absent = [f for f in listed if not os.path.exists(os.path.join(PUBLIC, f))]
    assert not absent, f"APP_FILES lists files that don't exist: {absent}"


def test_index_html_not_precached_directly():
    # Cloudflare Pages redirects /index.html to /, and a redirected response can't be used
    # for a page load, so the page must be cached as './'.
    assert "index.html" not in _sw_list("APP_FILES")
