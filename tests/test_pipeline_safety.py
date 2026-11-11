"""Tests for the pipeline's data-safety guards."""
import json
from datetime import datetime, timezone

import pytest
from botocore.exceptions import ClientError

import r2_sync
import scraper
from scraper import (
    carry_forward_missing,
    extract_store_metadata,
    process_and_save,
    save_data,
    scraper_timestamp,
)


def _page(ld) -> str:
    return f'<html><script type="application/ld+json">{json.dumps(ld)}</script></html>'


LOCAL_BUSINESS = {
    "@type": "LocalBusiness",
    "geo": {"latitude": "37.5", "longitude": "-120.8"},
    "address": {"streetAddress": "1 MAIN ST", "addressLocality": "TURLOCK",
                "addressRegion": "CA", "postalCode": "95380"},
    "department": [{"@type": "GasStation", "name": "Gas Station"}],
}


@pytest.mark.parametrize("ld", [
    [{"@type": "Organization"}, LOCAL_BUSINESS],
    {"@context": "https://schema.org", "@graph": [{"@type": "WebPage"}, LOCAL_BUSINESS]},
])
def test_extract_store_metadata_handles_list_and_graph_json_ld(ld):
    meta = extract_store_metadata(_page(ld))
    assert meta is not None
    assert meta["lat"] == 37.5 and meta["has_gas"] is True


def test_extract_store_metadata_ignores_non_object_json_ld():
    assert extract_store_metadata(_page(["just", "strings", 3])) is None


def test_scraper_timestamp_is_pacific_regardless_of_machine_tz():
    # 2026-07-01 19:30 UTC is 12:30 PDT
    assert scraper_timestamp(datetime(2026, 7, 1, 19, 30, tzinfo=timezone.utc)) == "2026-07-01 12:30"


def test_carry_forward_missing_fills_failed_stores_only_if_still_listed():
    locations = {"CA": {"A": {}, "B": {}}, "TX": {"C": {}}}
    fetched = {"CA": {"A": [4.0, 4.5, None]}}
    last_known = {"CA": {"A": [3.9, 4.4, None], "B": [4.1, 4.6, None], "Gone": [1, 1, 1]},
                  "TX": {"C": [3.0, 3.4, 3.5]}}
    merged, carried = carry_forward_missing(fetched, last_known, locations)
    assert carried == 2
    assert merged == {"CA": {"A": [4.0, 4.5, None], "B": [4.1, 4.6, None]},
                      "TX": {"C": [3.0, 3.4, 3.5]}}


def test_process_and_save_keeps_failed_store_in_latest(tmp_path, monkeypatch):
    hist, latest = tmp_path / "h.json", tmp_path / "l.json"
    latest.write_text(json.dumps({"timestamp": "2026-11-10 09:00",
                                  "prices": {"CA": {"A": [4.0, 4.5, None], "B": [4.1, 4.6, None]}}}))
    hist.write_text(json.dumps({"2026-11-10 09:00": {"CA": {"A": [4.0, 4.5, None], "B": [4.1, 4.6, None]}}}))
    monkeypatch.setattr(scraper, "get_gas_prices_ajax",
                        lambda *a, **k: {"2026-11-10 10:00": {"CA": {"A": [3.9, 4.4, None]}}})
    monkeypatch.setattr(scraper, "SNAPSHOT_STORE_COVERAGE_THRESHOLD", 0.5)

    assert process_and_save({"CA": {"A": {}, "B": {}}}, str(hist), str(latest), "T")
    data = json.loads(latest.read_text())
    assert data["prices"]["CA"]["B"] == [4.1, 4.6, None]
    # The carried-forward store did not change, so history only records A.
    assert json.loads(hist.read_text())["2026-11-10 10:00"] == {"CA": {"A": [3.9, 4.4, None]}}


def test_save_data_skips_timestamp_not_after_last_entry(tmp_path):
    hist, latest = tmp_path / "h.json", tmp_path / "l.json"
    save_data({"2026-11-01 01:50": {"CA": {"A": [4.0, 4.5, None]}}}, str(hist), str(latest))
    before_hist, before_latest = hist.read_text(), latest.read_text()

    # Clocks fell back: the next hourly run is stamped 01:05 again.
    assert save_data({"2026-11-01 01:05": {"CA": {"A": [3.0, 3.5, None]}}}, str(hist), str(latest)) is True
    assert hist.read_text() == before_hist
    assert latest.read_text() == before_latest


def test_save_data_reports_unreadable_history(tmp_path):
    hist, latest = tmp_path / "h.json", tmp_path / "l.json"
    hist.write_text("{not json")
    assert save_data({"2026-11-01 10:00": {"CA": {"A": [4.0, 4.5, None]}}}, str(hist), str(latest)) is False
    assert not latest.exists()


def test_main_rejects_unknown_option(monkeypatch):
    monkeypatch.setattr("sys.argv", ["scraper.py", "7"])
    with pytest.raises(SystemExit) as exc:
        scraper.main()
    assert exc.value.code == 1


class _FakeClient:
    def __init__(self, error_code):
        self.error_code = error_code

    def download_file(self, bucket, key, dest):
        if self.error_code:
            raise ClientError({"Error": {"Code": self.error_code}}, "GetObject")
        with open(dest, "w") as f:
            f.write("{}")


@pytest.fixture
def r2_env(tmp_path, monkeypatch):
    monkeypatch.setenv("R2_BUCKET_NAME", "bucket")
    monkeypatch.setattr(r2_sync, "SNAPSHOT_DIR", str(tmp_path))
    monkeypatch.setattr(r2_sync, "snapshot_path", lambda name: str(tmp_path / name))
    return tmp_path


def test_download_missing_object_is_not_an_error(r2_env, monkeypatch):
    monkeypatch.setattr(r2_sync, "get_s3_client", lambda: _FakeClient("NoSuchKey"))
    r2_sync.download_files(["us_history.json"])  # no SystemExit


def test_download_failure_stops_the_job(r2_env, monkeypatch):
    monkeypatch.setattr(r2_sync, "get_s3_client", lambda: _FakeClient("InternalError"))
    with pytest.raises(SystemExit) as exc:
        r2_sync.download_files(["us_history.json"])
    assert exc.value.code == 1
    assert not (r2_env / "us_history.json").exists()
