import json
import requests
from unittest.mock import patch, MagicMock

from scraper import (
    format_price,
    get_warehouse_id,
    extract_store_metadata,
    load_store_locations,
    save_data,
    write_pretty_top_level,
    remove_location_from_file,
    get_gas_prices_ajax,
    extract_stores_from_html,
    is_suspicious_jump,
    _prices_match,
    _find_quorum,
    confirm_or_revert_price,
    load_latest_prices,
    log_unconfirmed_jumps,
    summarize_unconfirmed_jumps,
    validate_snapshot,
    find_trend_baseline,
    fetch_state_codes,
    discover_new_stores,
    build_and_save_master_db,
    sort_stores_dict,
    refresh_store_details,
)


# --- UTILITY FUNCTION TESTS ---

def test_format_price():
    assert format_price("$3.49") == 3.49
    assert format_price(" 4.99 ") == 4.99
    assert format_price("N/A") is None
    assert format_price("") is None
    assert format_price(None) is None
    assert format_price("Invalid") is None


def test_get_warehouse_id():
    assert get_warehouse_id("https://www.costco.com/warehouse-locations/city-name-123.html") == "123"
    assert get_warehouse_id("https://www.costco.com/w/-/st/name/456") == "456"
    assert get_warehouse_id("https://www.costco.com/w/-/st/name/456/") == "456"
    assert get_warehouse_id("warehouseid=789") == "789"


# --- HTML PARSING & SITEMAP DISCOVERY TESTS ---

def test_extract_store_metadata():
    mock_html = """
    <html>
        <script type="application/ld+json">
        {
            "@type": "LocalBusiness",
            "geo": {"latitude": "37.7749", "longitude": "-122.4194"},
            "address": {
                "streetAddress": "123 Test St",
                "addressLocality": "Test City",
                "addressRegion": "CA",
                "postalCode": "90210"
            },
            "department": [{"@type": "GasStation", "name": "Gas Station"}]
        }
        </script>
    </html>
    """
    metadata = extract_store_metadata(mock_html)
    assert metadata is not None
    assert metadata["lat"] == 37.7749
    assert metadata["lng"] == -122.4194
    assert metadata["address"] == "123 Test St, Test City, CA 90210"
    assert metadata["has_gas"] is True


def test_extract_store_metadata_no_gas():
    mock_html = """
    <html>
        <script type="application/ld+json">
        {
            "@type": "LocalBusiness",
            "geo": {"latitude": "37.7749", "longitude": "-122.4194"},
            "department": [{"@type": "Pharmacy", "name": "Pharmacy"}]
        }
        </script>
    </html>
    """
    metadata = extract_store_metadata(mock_html)
    assert metadata is not None
    assert metadata["has_gas"] is False


def test_extract_stores_from_html():
    mock_html = """
    <html>
        <body>
            <a href="/warehouse-locations/seattle-wa-111.html">Seattle</a>
            <a href="https://www.costco.com/w/-/st/austin/222">Austin</a>
            <a href="/privacy-policy">Privacy Policy</a>
            <a href="https://www.google.com">Google</a>
        </body>
    </html>
    """
    stores = extract_stores_from_html(mock_html)

    assert len(stores) == 2
    assert "Seattle" in stores
    assert "Austin" in stores
    assert stores["Seattle"] == "https://www.costco.com/warehouse-locations/seattle-wa-111.html"
    assert stores["Austin"] == "https://www.costco.com/w/-/st/austin/222"


@patch('scraper.fetch_directory_html')
def test_fetch_state_codes_excludes_pr_and_sorts(mock_fetch):
    mock_fetch.return_value = """
    <html><body>
        <a href="/sitemaps/warehouses-by-state/WA">WA</a>
        <a href="/sitemaps/warehouses-by-state/CA/">CA</a>
        <a href="/sitemaps/warehouses-by-state/PR">PR</a>
        <a href="/sitemaps/warehouses-by-state/invalid">Invalid</a>
    </body></html>
    """
    assert fetch_state_codes() == ["CA", "WA"]


@patch('scraper.enrich_store_list')
@patch('scraper.fetch_directory_html')
def test_discover_new_stores_writes_sorted_json(mock_fetch, mock_enrich, tmp_path):
    mock_fetch.return_value = '<a href="/w/-/ca/albany/999">Albany</a><a href="/w/-/ca/turlock/782">Turlock</a>'
    mock_enrich.return_value = {
        "CA": {"Albany": {"url": "https://www.costco.com/w/-/ca/albany/999", "warehouse_id": "999"}}
    }
    existing = {
        "TX": {"Austin": {"url": "https://www.costco.com/w/-/tx/austin/111", "warehouse_id": "111"}},
        "CA": {"Turlock": {"url": "https://www.costco.com/w/-/ca/turlock/782", "warehouse_id": "782"}},
    }
    out_file = tmp_path / "stores.json"
    result = discover_new_stores(["CA"], existing, str(out_file))

    saved = json.loads(out_file.read_text())
    assert list(saved.keys()) == ["CA", "TX"]
    assert list(saved["CA"].keys()) == ["Albany", "Turlock"]
    assert result == saved


@patch('scraper.enrich_store_list')
@patch('scraper.fetch_directory_html')
def test_discover_new_stores_no_gas_does_not_modify_file(mock_fetch, mock_enrich, tmp_path):
    mock_fetch.return_value = '<a href="/w/-/ca/nogas/999">NoGas</a>'
    mock_enrich.return_value = {"CA": {}}
    existing = {
        "CA": {"Turlock": {"url": "https://www.costco.com/w/-/ca/turlock/782", "warehouse_id": "782"}}
    }
    out_file = tmp_path / "stores.json"
    out_file.write_text(json.dumps(existing, indent=4))
    mtime_before = out_file.stat().st_mtime_ns

    result = discover_new_stores(["CA"], existing, str(out_file))
    assert result == existing
    assert out_file.stat().st_mtime_ns == mtime_before


def test_sort_stores_dict():
    raw = {
        "WA": {"Seattle": {}, "Bellevue": {}},
        "CA": {"San Francisco": {}, "Alhambra": {}},
    }
    sorted_dict = sort_stores_dict(raw)
    assert list(sorted_dict.keys()) == ["CA", "WA"]
    assert list(sorted_dict["CA"].keys()) == ["Alhambra", "San Francisco"]
    assert list(sorted_dict["WA"].keys()) == ["Bellevue", "Seattle"]


def test_remove_location_from_file_preserves_sort(tmp_path):
    stores_file = tmp_path / "stores.json"
    initial = {
        "TX": {"Dallas": {}, "Austin": {}, "Houston": {}},
        "CA": {"San Diego": {}, "Bakersfield": {}, "Alhambra": {}}
    }
    stores_file.write_text(json.dumps(initial))
    remove_location_from_file(str(stores_file), "TX", "Dallas")

    saved = json.loads(stores_file.read_text())
    assert list(saved.keys()) == ["CA", "TX"]
    assert list(saved["CA"].keys()) == ["Alhambra", "Bakersfield", "San Diego"]
    assert list(saved["TX"].keys()) == ["Austin", "Houston"]


@patch('scraper._fetch_store_page_metadata')
@patch('scraper.create_session')
def test_refresh_store_details_writes_sorted_json(mock_session, mock_fetch_meta, tmp_path):
    mock_fetch_meta.return_value = {"phone": "123-456-7890"}
    stores = {
        "TX": {"Houston": {"url": "http://u1"}, "Austin": {"url": "http://u2"}},
        "CA": {"Fresno": {"url": "http://u3"}, "Bakersfield": {"url": "http://u4"}}
    }
    out_file = tmp_path / "stores.json"
    refresh_store_details(stores, str(out_file))

    saved = json.loads(out_file.read_text())
    assert list(saved.keys()) == ["CA", "TX"]
    assert list(saved["CA"].keys()) == ["Bakersfield", "Fresno"]
    assert list(saved["TX"].keys()) == ["Austin", "Houston"]


@patch('scraper.enrich_store_list')
@patch('scraper.fetch_directory_html')
def test_build_and_save_master_db_guards_against_large_drop(mock_fetch, mock_enrich, tmp_path):
    out_file = tmp_path / "us_stores.json"
    existing = {"CA": {f"City{i}": {"warehouse_id": str(i)} for i in range(10)}}
    out_file.write_text(json.dumps(existing))

    mock_fetch.return_value = '<a href="/w/-/ca/city0/0">City0</a>'
    mock_enrich.return_value = {"CA": {"City0": {"warehouse_id": "0"}}}

    build_and_save_master_db(["CA"], str(out_file))
    # Should refuse to overwrite when 90% of stores disappear
    assert len(json.loads(out_file.read_text())["CA"]) == 10


# --- SNAPSHOT VALIDATION & TREND BASELINE TESTS ---

def test_validate_snapshot_thresholds():
    locations = {
        f"S{i}": {f"C{j}": {} for j in range(4)}
        for i in range(10)
    }
    # Full coverage -> valid
    ok, _ = validate_snapshot(locations, locations)
    assert ok is True

    # Too few states (8/10 = 80% < 85%) -> invalid
    sparse_states = {f"S{i}": locations[f"S{i}"] for i in range(8)}
    ok, reason = validate_snapshot(sparse_states, locations)
    assert ok is False and "states" in reason

    # Enough states (9/10 = 90%), but too few stores (18/40 = 45% < 75%) -> invalid
    sparse_stores = {f"S{i}": {"C0": {}, "C1": {}} for i in range(9)}
    ok, reason = validate_snapshot(sparse_stores, locations)
    assert ok is False and "stores" in reason


def test_find_trend_baseline_prefers_72h_window_and_falls_back():
    history = {
        "2026-07-01 10:00": {"CA": {"LA": [4.10, 4.40, None]}},
        "2026-07-03 18:00": {"CA": {"LA": [4.30, 4.60, None]}},
        "2026-07-04 02:00": {"CA": {"LA": [4.35, 4.65, None]}},
    }
    # 72h before 2026-07-04 10:00 is 2026-07-01 10:00
    prices, ts = find_trend_baseline(history, "2026-07-04 10:00")
    assert ts == "2026-07-01 10:00"
    assert prices["CA"]["LA"][0] == 4.10

    # Short history (no snapshot near 72h back) falls back to latest prior run
    short_history = {"2026-07-04 02:00": {"CA": {"LA": [4.35, 4.65, None]}}}
    prices, ts = find_trend_baseline(short_history, "2026-07-04 10:00")
    assert ts == "2026-07-04 02:00"


# --- FILE I/O TESTS ---

def test_load_store_locations(tmp_path):
    file = tmp_path / "stores.json"
    file.write_text('{"CA": {"Los Angeles": {"warehouse_id": "123"}}}')

    data = load_store_locations(str(file))
    assert data is not None
    assert data["CA"]["Los Angeles"]["warehouse_id"] == "123"


def test_load_store_locations_missing():
    assert load_store_locations("does_not_exist.json") is None


def test_write_pretty_top_level(tmp_path):
    file = tmp_path / "output.json"
    test_data = {"2023-10-27 12:00": {"CA": {"LA": [4.99, 5.29, None]}}}
    write_pretty_top_level(test_data, str(file))

    content = file.read_text()
    assert "{" in content
    assert '"2023-10-27 12:00": {"CA":{"LA":[4.99,5.29,null]}}' in content


def test_remove_location_from_file(tmp_path):
    file = tmp_path / "stores.json"
    initial_data = {
        "CA": {
            "Los Angeles": {"warehouse_id": "123"},
            "San Diego": {"warehouse_id": "456"}
        }
    }
    file.write_text(json.dumps(initial_data))

    remove_location_from_file(str(file), "CA", "Los Angeles")

    updated_data = json.loads(file.read_text())
    assert "Los Angeles" not in updated_data["CA"]
    assert "San Diego" in updated_data["CA"]


def test_save_data_appends_correctly(tmp_path):
    history_file = tmp_path / "historical_prices.json"
    latest_file = tmp_path / "latest_prices.json"

    initial_data = {"2023-10-01 10:00": {"CA": {"LA": [4.50, 4.80, None]}}}
    history_file.write_text(json.dumps(initial_data))

    new_data = {"2023-10-02 10:00": {"CA": {"LA": [4.45, 4.75, 5.15]}}}

    save_data(new_data, str(history_file), str(latest_file))

    saved_content = json.loads(history_file.read_text())
    assert "2023-10-01 10:00" in saved_content
    assert "2023-10-02 10:00" in saved_content
    assert saved_content["2023-10-02 10:00"]["CA"]["LA"] == [4.45, 4.75, 5.15]

    latest_content = json.loads(latest_file.read_text())
    assert latest_content["timestamp"] == "2023-10-02 10:00"
    assert latest_content["prices"]["CA"]["LA"] == [4.45, 4.75, 5.15]


def test_save_data_handles_corrupt_json(tmp_path, capsys):
    history_file = tmp_path / "corrupt.json"
    latest_file = tmp_path / "latest_prices.json"

    history_file.write_text("{ THIS IS NOT VALID JSON }")

    new_data = {"2023-10-02 10:00": {"CA": {"LA": [4.45, 4.75, None]}}}

    save_data(new_data, str(history_file), str(latest_file))

    assert history_file.read_text() == "{ THIS IS NOT VALID JSON }"
    captured = capsys.readouterr()
    assert "contains invalid JSON" in captured.out


# --- NETWORK MOCKING TESTS ---

@patch('scraper.create_session')
def test_get_gas_prices_ajax(mock_create_session):
    mock_session = MagicMock()
    mock_response = MagicMock()

    mock_response.json.return_value = {
        "123": {
            "regular": "4.99",
            "premium": "5.29"
        }
    }
    mock_response.raise_for_status.return_value = None
    mock_session.get.return_value = mock_response
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Los Angeles": {"warehouse_id": "123"}}}
    result = get_gas_prices_ajax(locations)

    timestamp_key = next(iter(result.keys()))
    prices = result[timestamp_key]["CA"]["Los Angeles"]
    assert prices == [4.99, 5.29, None]
    mock_session.get.assert_called_once()


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_max_retries(mock_sleep, mock_create_session, tmp_path):
    mock_session = MagicMock()
    mock_session.get.side_effect = requests.exceptions.RequestException("Connection refused")
    mock_create_session.return_value = mock_session

    dummy_file = tmp_path / "dummy_stores.json"
    dummy_file.write_text(json.dumps({"CA": {"Fail City": {"warehouse_id": "999"}}}))

    locations = {"CA": {"Fail City": {"warehouse_id": "999"}}}
    result = get_gas_prices_ajax(locations, source_filepath=str(dummy_file))

    timestamp_key = next(iter(result.keys()))
    assert result[timestamp_key] == {}
    assert mock_session.get.call_count == 5
    assert mock_sleep.call_count == 5


# --- PRICE-JUMP SANITY CHECK TESTS ---

def _resp(reg, prem, diesel=None):
    """Fake requests.Response-like object matching Costco's AJAX shape."""
    mock_response = MagicMock()
    mock_response.raise_for_status.return_value = None
    data = {"regular": reg, "premium": prem}
    if diesel is not None:
        data["diesel"] = diesel
    mock_response.json.return_value = {"12345": data}
    return mock_response


def test_is_suspicious_jump_no_baseline_never_flags():
    assert is_suspicious_jump(5.00, None) is False
    assert is_suspicious_jump(None, 5.00) is False
    assert is_suspicious_jump(None, None) is False


def test_is_suspicious_jump_small_move_not_suspicious():
    assert is_suspicious_jump(5.00, 5.00) is False
    assert is_suspicious_jump(5.05, 5.00) is False
    assert is_suspicious_jump(5.25, 5.00) is False


def test_is_suspicious_jump_exact_absolute_threshold_triggers():
    assert is_suspicious_jump(5.30, 5.00) is True


def test_is_suspicious_jump_percentage_threshold_triggers_on_cheap_gas():
    assert is_suspicious_jump(0.55, 0.50) is True


def test_prices_match():
    assert _prices_match(5.001, 5.00) is True
    assert _prices_match(5.10, 5.00) is False
    assert _prices_match(None, None) is True
    assert _prices_match(None, 5.00) is False
    assert _prices_match(5.00, None) is False


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_confirms_real_change(mock_sleep):
    new_prices = {"regular": 4.50, "premium": 5.60, "diesel": None}
    last_prices = {"regular": 5.10, "premium": 5.60, "diesel": None}
    refetch = MagicMock(side_effect=[
        {"regular": 4.50, "premium": 5.60, "diesel": None},
        {"regular": 4.50, "premium": 5.60, "diesel": None},
        {"regular": 4.50, "premium": 5.60, "diesel": None},
    ])
    final_prices, flagged = confirm_or_revert_price("CA", "Danville", new_prices, last_prices, refetch)
    assert final_prices == {"regular": 4.50, "premium": 5.60, "diesel": None}
    assert flagged is False
    assert refetch.call_count == 3


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_reverts_glitch(mock_sleep):
    glitch_prices = {"regular": 1.00, "premium": 5.60, "diesel": None}
    last_prices = {"regular": 5.10, "premium": 5.60, "diesel": None}
    refetch = MagicMock(side_effect=[
        {"regular": 5.10, "premium": 5.60, "diesel": None},
        {"regular": 5.10, "premium": 5.60, "diesel": None},
        {"regular": 5.10, "premium": 5.60, "diesel": None},
    ])
    final_prices, flagged = confirm_or_revert_price("CA", "Danville", glitch_prices, last_prices, refetch)
    assert final_prices == {"regular": 5.10, "premium": 5.60, "diesel": None}
    assert flagged is False
    assert refetch.call_count == 3


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_inconclusive_keeps_freshest_and_flags(mock_sleep):
    glitch_prices = {"regular": 1.00, "premium": 5.60, "diesel": None}
    last_prices = {"regular": 5.10, "premium": 5.60, "diesel": None}
    refetch = MagicMock(side_effect=[
        {"regular": 2.00, "premium": 5.60, "diesel": None},
        {"regular": 3.00, "premium": 5.60, "diesel": None},
        {"regular": 4.00, "premium": 5.60, "diesel": None},
        {"regular": 5.00, "premium": 5.60, "diesel": None},
        {"regular": 6.00, "premium": 5.60, "diesel": None},
    ])
    final_prices, flagged = confirm_or_revert_price("CA", "Danville", glitch_prices, last_prices, refetch)
    assert final_prices == {"regular": 6.00, "premium": 5.60, "diesel": None}
    assert flagged is True
    assert refetch.call_count == 5


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_mixed_only_suspicious_grade_confirmed(mock_sleep):
    mixed_prices = {"regular": 5.10, "premium": 6.50, "diesel": None}
    last_prices = {"regular": 5.10, "premium": 5.60, "diesel": None}
    refetch = MagicMock(side_effect=[
        {"regular": 5.10, "premium": 6.50, "diesel": None},
        {"regular": 5.10, "premium": 6.50, "diesel": None},
        {"regular": 5.10, "premium": 6.50, "diesel": None},
    ])
    final_prices, flagged = confirm_or_revert_price("CA", "Danville", mixed_prices, last_prices, refetch)
    assert final_prices == {"regular": 5.10, "premium": 6.50, "diesel": None}
    assert flagged is False
    assert refetch.call_count == 3


def test_find_quorum_handles_floats_and_none():
    # Quorum of 3 on floats
    has_q, val = _find_quorum([5.00, 5.00, 5.00])
    assert has_q is True and val == 5.00

    # Quorum of 3 on None (e.g. confirming no diesel)
    has_q, val = _find_quorum([None, None, None])
    assert has_q is True and val is None

    # Inconclusive (only 2 agreeing when quorum is 3)
    has_q, val = _find_quorum([5.00, 5.00, 5.10])
    assert has_q is False and val is None

    # Resolves to majority with noise (3 out of 4)
    has_q, val = _find_quorum([5.00, 5.10, 5.00, 5.00])
    assert has_q is True and val == 5.00


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_verify_all_small_change_confirmed(mock_sleep):
    # Small $0.05 move confirms when 3 rechecks agree
    new_prices = {"regular": 5.05, "premium": 5.60, "diesel": None}
    last_prices = {"regular": 5.00, "premium": 5.60, "diesel": None}
    refetch = MagicMock(side_effect=[
        {"regular": 5.05, "premium": 5.60, "diesel": None},
        {"regular": 5.05, "premium": 5.60, "diesel": None},
        {"regular": 5.05, "premium": 5.60, "diesel": None},
    ])
    final_prices, flagged = confirm_or_revert_price(
        "CA", "Danville", new_prices, last_prices, refetch, verify_all_changes=True
    )
    assert final_prices == {"regular": 5.05, "premium": 5.60, "diesel": None}
    assert flagged is False
    assert refetch.call_count == 3


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_verify_all_small_change_reverts_glitch(mock_sleep):
    # Small $0.05 transient glitch reverts to last known price
    glitch_prices = {"regular": 5.05, "premium": 5.60, "diesel": None}
    last_prices = {"regular": 5.00, "premium": 5.60, "diesel": None}
    refetch = MagicMock(side_effect=[
        {"regular": 5.00, "premium": 5.60, "diesel": None},
        {"regular": 5.00, "premium": 5.60, "diesel": None},
        {"regular": 5.00, "premium": 5.60, "diesel": None},
    ])
    final_prices, flagged = confirm_or_revert_price(
        "CA", "Danville", glitch_prices, last_prices, refetch, verify_all_changes=True
    )
    assert final_prices == {"regular": 5.00, "premium": 5.60, "diesel": None}
    assert flagged is False
    assert refetch.call_count == 3


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_verify_all_inconclusive_reverts_to_last(mock_sleep):
    # If rechecks flap and cannot reach quorum, revert to last known price instead of saving jitter
    glitch_prices = {"regular": 5.05, "premium": 5.60, "diesel": None}
    last_prices = {"regular": 5.00, "premium": 5.60, "diesel": None}
    refetch = MagicMock(side_effect=[
        {"regular": 5.05, "premium": 5.60, "diesel": None},
        {"regular": 5.00, "premium": 5.60, "diesel": None},
        {"regular": 5.10, "premium": 5.60, "diesel": None},
        {"regular": 5.15, "premium": 5.60, "diesel": None},
        {"regular": 5.20, "premium": 5.60, "diesel": None},
    ])
    final_prices, flagged = confirm_or_revert_price(
        "CA", "Danville", glitch_prices, last_prices, refetch, verify_all_changes=True
    )
    assert final_prices == {"regular": 5.00, "premium": 5.60, "diesel": None}
    assert flagged is True
    assert refetch.call_count == 5


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_diesel_phantom_glitch_reverted(mock_sleep):
    # Phantom diesel (None -> 7.60) from cached node reverts back to None
    glitch_prices = {"regular": 5.00, "premium": 5.60, "diesel": 7.60}
    last_prices = {"regular": 5.00, "premium": 5.60, "diesel": None}
    refetch = MagicMock(side_effect=[
        {"regular": 5.00, "premium": 5.60, "diesel": None},
        {"regular": 5.00, "premium": 5.60, "diesel": None},
        {"regular": 5.00, "premium": 5.60, "diesel": None},
    ])
    final_prices, flagged = confirm_or_revert_price(
        "CA", "Danville", glitch_prices, last_prices, refetch, verify_all_changes=True
    )
    assert final_prices == {"regular": 5.00, "premium": 5.60, "diesel": None}
    assert flagged is False
    assert refetch.call_count == 3


def test_load_latest_prices_missing_file_returns_empty():
    assert load_latest_prices("does_not_exist_12345.json") == {}


def test_load_latest_prices_valid_file(tmp_path):
    file = tmp_path / "us_latest.json"
    file.write_text(json.dumps({"timestamp": "2026-01-01 00:00", "prices": {"CA": {"Danville": [5.1, 5.6, 5.8]}}}))
    assert load_latest_prices(str(file)) == {"CA": {"Danville": [5.1, 5.6, 5.8]}}


def test_load_latest_prices_corrupt_file_returns_empty(tmp_path):
    file = tmp_path / "corrupt_latest.json"
    file.write_text("{ not valid json")
    assert load_latest_prices(str(file)) == {}


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_no_jump_makes_single_call(mock_sleep, mock_create_session):
    mock_session = MagicMock()
    mock_session.get.return_value = _resp("5.15", "5.65")
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60, None]}}
    result = get_gas_prices_ajax(locations, None, last_known)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [5.15, 5.65, None]
    mock_session.get.assert_called_once()


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_real_change_confirmed(mock_sleep, mock_create_session):
    mock_session = MagicMock()
    mock_session.get.side_effect = [
        _resp("4.50", "5.60"),
        _resp("4.50", "5.60"),
        _resp("4.50", "5.60"),
        _resp("4.50", "5.60"),
    ]
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60, None]}}
    result = get_gas_prices_ajax(locations, None, last_known)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [4.50, 5.60, None]
    assert mock_session.get.call_count == 4


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_glitch_reverted(mock_sleep, mock_create_session):
    mock_session = MagicMock()
    mock_session.get.side_effect = [
        _resp("1.00", "5.60"),
        _resp("5.10", "5.60"),
        _resp("5.10", "5.60"),
        _resp("5.10", "5.60"),
    ]
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60, None]}}
    result = get_gas_prices_ajax(locations, None, last_known)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [5.10, 5.60, None]
    assert mock_session.get.call_count == 4


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_inconclusive_flags_but_keeps_freshest(mock_sleep, mock_create_session, capsys):
    mock_session = MagicMock()
    mock_session.get.side_effect = [
        _resp("1.00", "5.60"),
        _resp("2.00", "5.60"),
        _resp("3.00", "5.60"),
        _resp("4.00", "5.60"),
        _resp("5.00", "5.60"),
        _resp("6.00", "5.60"),
    ]
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60, None]}}
    result = get_gas_prices_ajax(locations, None, last_known)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [6.00, 5.60, None]
    captured = capsys.readouterr()
    assert "couldn't be confirmed" in captured.out


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_no_baseline_never_triggers_recheck(mock_sleep, mock_create_session):
    mock_session = MagicMock()
    mock_session.get.return_value = _resp("1.00", "1.50")
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    result = get_gas_prices_ajax(locations, None, None)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [1.00, 1.50, None]
    mock_session.get.assert_called_once()


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_two_phase_sweep_only_rechecks_changed_store(mock_sleep, mock_create_session):
    mock_session = MagicMock()
    # Fresno is unchanged: calls return 4.50, 4.80
    # Danville changed from 5.10 to 5.05: initial returns 5.05, rechecks return 5.05
    def mock_get(url, *args, **kwargs):
        if "warehouseid=1" in url:
            return _resp("4.50", "4.80")
        elif "warehouseid=2" in url:
            return _resp("5.05", "5.60")
        raise ValueError(f"Unexpected url {url}")

    mock_session.get.side_effect = mock_get
    mock_create_session.return_value = mock_session

    locations = {
        "CA": {
            "Fresno": {"warehouse_id": "1"},
            "Danville": {"warehouse_id": "2"},
        }
    }
    last_known = {
        "CA": {
            "Fresno": [4.50, 4.80, None],     # Matches! No change
            "Danville": [5.10, 5.60, None],   # Changed 5.10 -> 5.05
        }
    }

    result = get_gas_prices_ajax(locations, None, last_known, verify_all_changes=True)
    ts = next(iter(result))
    assert result[ts]["CA"]["Fresno"] == [4.50, 4.80, None]
    assert result[ts]["CA"]["Danville"] == [5.05, 5.60, None]

    # Total calls: Fresno (1 in Phase 1) + Danville (1 in Phase 1 + 3 in Phase 2) = 5
    assert mock_session.get.call_count == 5


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_logs_unconfirmed_jump_when_path_given(mock_sleep, mock_create_session, tmp_path):
    mock_session = MagicMock()
    mock_session.get.side_effect = [
        _resp("1.00", "5.60"),
        _resp("2.00", "5.60"),
        _resp("3.00", "5.60"),
        _resp("4.00", "5.60"),
        _resp("5.00", "5.60"),
        _resp("6.00", "5.60"),
    ]
    mock_create_session.return_value = mock_session

    log_file = tmp_path / "jumps.jsonl"
    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60, None]}}
    get_gas_prices_ajax(
        locations, None, last_known,
        jump_log_filepath=str(log_file), dataset_label="Local",
    )

    lines = log_file.read_text().strip().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["state"] == "CA"
    assert record["city"] == "Danville"
    assert record["dataset"] == "Local"
    assert record["last_reg"] == 5.10
    assert record["raw_reg"] == 1.00
    assert record["final_reg"] == 6.00


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_no_log_file_written_when_no_jumps(mock_sleep, mock_create_session, tmp_path):
    mock_session = MagicMock()
    mock_session.get.return_value = _resp("5.15", "5.65")
    mock_create_session.return_value = mock_session

    log_file = tmp_path / "jumps.jsonl"
    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60, None]}}
    get_gas_prices_ajax(locations, None, last_known, jump_log_filepath=str(log_file))

    assert not log_file.exists()


def test_log_unconfirmed_jumps_appends_without_clobbering(tmp_path):
    log_file = tmp_path / "jumps.jsonl"
    log_unconfirmed_jumps([{"state": "CA", "city": "Danville"}], str(log_file))
    log_unconfirmed_jumps([{"state": "TX", "city": "Austin"}], str(log_file))

    lines = log_file.read_text().strip().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["city"] == "Danville"
    assert json.loads(lines[1])["city"] == "Austin"


def test_log_unconfirmed_jumps_empty_records_no_op(tmp_path):
    log_file = tmp_path / "jumps.jsonl"
    log_unconfirmed_jumps([], str(log_file))
    assert not log_file.exists()


def test_summarize_unconfirmed_jumps_missing_file(capsys):
    summarize_unconfirmed_jumps("does_not_exist_12345.jsonl")
    captured = capsys.readouterr()
    assert "No unconfirmed-jumps log found" in captured.out


def test_summarize_unconfirmed_jumps_counts_and_ranks(tmp_path, capsys):
    log_file = tmp_path / "jumps.jsonl"
    records = (
        [{"state": "CA", "city": "Danville"}] * 3
        + [{"state": "TX", "city": "Austin"}] * 1
    )
    log_unconfirmed_jumps(records, str(log_file))

    summarize_unconfirmed_jumps(str(log_file))
    captured = capsys.readouterr()
    assert "4 unconfirmed jump(s) logged across 2 store(s)" in captured.out
    danville_pos = captured.out.find("Danville")
    austin_pos = captured.out.find("Austin")
    assert 0 <= danville_pos < austin_pos


def test_summarize_unconfirmed_jumps_skips_corrupt_lines(tmp_path, capsys):
    log_file = tmp_path / "jumps.jsonl"
    log_file.write_text('{"state": "CA", "city": "Danville"}\nnot valid json\n\n')

    summarize_unconfirmed_jumps(str(log_file))
    captured = capsys.readouterr()
    assert "1 unconfirmed jump(s) logged across 1 store(s)" in captured.out


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_missing_grade_does_not_false_flag(mock_sleep, mock_create_session):
    mock_session = MagicMock()
    mock_session.get.return_value = _resp("5.15", "N/A")
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60, None]}}
    result = get_gas_prices_ajax(locations, None, last_known)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [5.15, None, None]
    mock_session.get.assert_called_once()
