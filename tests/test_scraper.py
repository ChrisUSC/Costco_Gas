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
    confirm_or_revert_price,
    load_latest_prices,
    log_unconfirmed_jumps,
    summarize_unconfirmed_jumps,
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


# --- HTML PARSING TESTS ---

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
    test_data = {"2023-10-27 12:00": {"CA": {"LA": [4.99, 5.29]}}}
    write_pretty_top_level(test_data, str(file))

    content = file.read_text()
    assert "{" in content
    assert '"2023-10-27 12:00": {"CA":{"LA":[4.99,5.29]}}' in content


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
    latest_file = tmp_path / "latest_prices.json"  # Added dummy latest file

    initial_data = {"2023-10-01 10:00": {"CA": {"LA": [4.50, 4.80]}}}
    history_file.write_text(json.dumps(initial_data))

    new_data = {"2023-10-02 10:00": {"CA": {"LA": [4.45, 4.75]}}}

    # Pass both paths to the function
    save_data(new_data, str(history_file), str(latest_file))

    saved_content = json.loads(history_file.read_text())
    assert "2023-10-01 10:00" in saved_content
    assert "2023-10-02 10:00" in saved_content
    assert saved_content["2023-10-02 10:00"]["CA"]["LA"] == [4.45, 4.75]

    # Optional: You can also assert the latest file was created correctly
    latest_content = json.loads(latest_file.read_text())
    assert latest_content["timestamp"] == "2023-10-02 10:00"


def test_save_data_handles_corrupt_json(tmp_path, capsys):
    history_file = tmp_path / "corrupt.json"
    latest_file = tmp_path / "latest_prices.json"  # Added dummy latest file

    history_file.write_text("{ THIS IS NOT VALID JSON }")

    new_data = {"2023-10-02 10:00": {"CA": {"LA": [4.45, 4.75]}}}

    # Pass both paths to the function
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
    assert prices == [4.99, 5.29]
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

    # FIX: Use mock_sleep to ensure the backoff delay was actually called 5 times
    assert mock_sleep.call_count == 5


# --- PRICE-JUMP SANITY CHECK TESTS ---

def _resp(reg, prem):
    """Fake requests.Response-like object matching Costco's AJAX shape."""
    mock_response = MagicMock()
    mock_response.raise_for_status.return_value = None
    mock_response.json.return_value = {"12345": {"regular": reg, "premium": prem}}
    return mock_response


def test_is_suspicious_jump_no_baseline_never_flags():
    assert is_suspicious_jump(5.00, None) is False
    assert is_suspicious_jump(None, 5.00) is False
    assert is_suspicious_jump(None, None) is False


def test_is_suspicious_jump_small_move_not_suspicious():
    assert is_suspicious_jump(5.00, 5.00) is False
    assert is_suspicious_jump(5.05, 5.00) is False  # $0.05 / 1%
    assert is_suspicious_jump(5.25, 5.00) is False  # $0.25 / 5% - under both thresholds


def test_is_suspicious_jump_exact_absolute_threshold_triggers():
    # Exactly $0.30 - would be missed if the diff weren't rounded first
    # (float subtraction can land at 0.2999999999999998).
    assert is_suspicious_jump(5.30, 5.00) is True


def test_is_suspicious_jump_percentage_threshold_triggers_on_cheap_gas():
    # diff=$0.05 (< $0.30 abs) but 10% (>= 8% pct) on a cheap $0.50 baseline
    assert is_suspicious_jump(0.55, 0.50) is True


def test_prices_match():
    assert _prices_match(5.001, 5.00) is True
    assert _prices_match(5.10, 5.00) is False
    assert _prices_match(None, None) is True
    assert _prices_match(None, 5.00) is False
    assert _prices_match(5.00, None) is False


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_confirms_real_change(mock_sleep):
    # Recheck agrees with the NEW (suspicious) price -> trust it
    refetch = MagicMock(side_effect=[(4.50, 5.60)])
    reg, prem, flagged = confirm_or_revert_price("CA", "Danville", 4.50, 5.60, 5.10, 5.60, refetch)
    assert (reg, prem, flagged) == (4.50, 5.60, False)
    assert refetch.call_count == 1


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_reverts_glitch(mock_sleep):
    # Recheck agrees with the OLD/last-known price -> original fetch was the glitch
    refetch = MagicMock(side_effect=[(5.10, 5.60)])
    reg, prem, flagged = confirm_or_revert_price("CA", "Danville", 1.00, 5.60, 5.10, 5.60, refetch)
    assert (reg, prem, flagged) == (5.10, 5.60, False)


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_inconclusive_keeps_freshest_and_flags(mock_sleep):
    # Recheck(s) agree with NEITHER old nor new -> keep freshest fetch, flag it
    refetch = MagicMock(side_effect=[(2.00, 5.60), (3.00, 5.60)])
    reg, prem, flagged = confirm_or_revert_price("CA", "Danville", 1.00, 5.60, 5.10, 5.60, refetch)
    assert (reg, prem) == (1.00, 5.60)
    assert flagged is True


@patch('scraper.time.sleep', return_value=None)
def test_confirm_or_revert_price_mixed_only_suspicious_grade_confirmed(mock_sleep):
    # Premium jumped, regular didn't move at all - only premium should need confirming
    refetch = MagicMock(side_effect=[(5.10, 6.50)])
    reg, prem, flagged = confirm_or_revert_price("CA", "Danville", 5.10, 6.50, 5.10, 5.60, refetch)
    assert (reg, prem, flagged) == (5.10, 6.50, False)


def test_load_latest_prices_missing_file_returns_empty():
    assert load_latest_prices("does_not_exist_12345.json") == {}


def test_load_latest_prices_valid_file(tmp_path):
    file = tmp_path / "us_latest.json"
    file.write_text(json.dumps({"timestamp": "2026-01-01 00:00", "prices": {"CA": {"Danville": [5.1, 5.6]}}}))
    assert load_latest_prices(str(file)) == {"CA": {"Danville": [5.1, 5.6]}}


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
    last_known = {"CA": {"Danville": [5.10, 5.60]}}
    result = get_gas_prices_ajax(locations, None, last_known)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [5.15, 5.65]
    mock_session.get.assert_called_once()


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_real_change_confirmed(mock_sleep, mock_create_session):
    mock_session = MagicMock()
    mock_session.get.side_effect = [_resp("4.50", "5.60"), _resp("4.50", "5.60")]
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60]}}
    result = get_gas_prices_ajax(locations, None, last_known)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [4.50, 5.60]
    assert mock_session.get.call_count == 2


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_glitch_reverted(mock_sleep, mock_create_session):
    mock_session = MagicMock()
    mock_session.get.side_effect = [_resp("1.00", "5.60"), _resp("5.10", "5.60")]
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60]}}
    result = get_gas_prices_ajax(locations, None, last_known)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [5.10, 5.60]


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_inconclusive_flags_but_keeps_freshest(mock_sleep, mock_create_session, capsys):
    mock_session = MagicMock()
    mock_session.get.side_effect = [_resp("1.00", "5.60"), _resp("2.00", "5.60"), _resp("3.00", "5.60")]
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60]}}
    result = get_gas_prices_ajax(locations, None, last_known)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [1.00, 5.60]
    captured = capsys.readouterr()
    assert "couldn't be confirmed" in captured.out


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_no_baseline_never_triggers_recheck(mock_sleep, mock_create_session):
    # First-ever run: no *_latest.json yet, so last_known_prices is {}
    mock_session = MagicMock()
    mock_session.get.return_value = _resp("1.00", "1.50")
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    result = get_gas_prices_ajax(locations, None, None)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [1.00, 1.50]
    mock_session.get.assert_called_once()


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_logs_unconfirmed_jump_when_path_given(mock_sleep, mock_create_session, tmp_path):
    # Same "inconclusive" scenario as above, but this time pass a
    # jump_log_filepath and confirm a record actually gets written.
    mock_session = MagicMock()
    mock_session.get.side_effect = [
        _resp("1.00", "5.60"), _resp("2.00", "5.60"), _resp("3.00", "5.60"), _resp("4.00", "5.60"),
    ]
    mock_create_session.return_value = mock_session

    log_file = tmp_path / "jumps.jsonl"
    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60]}}
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
    assert record["final_reg"] == 4.00


@patch('scraper.create_session')
@patch('scraper.time.sleep', return_value=None)
def test_get_gas_prices_ajax_no_log_file_written_when_no_jumps(mock_sleep, mock_create_session, tmp_path):
    # Confirming a normal (non-suspicious) fetch shouldn't touch the log file at all.
    mock_session = MagicMock()
    mock_session.get.return_value = _resp("5.15", "5.65")
    mock_create_session.return_value = mock_session

    log_file = tmp_path / "jumps.jsonl"
    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60]}}
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
    # Danville (3x) should be ranked above Austin (1x)
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
    # Premium comes back "N/A" (format_price -> None). A None new-value should
    # never be treated as a suspicious jump against a real last-known price.
    mock_session = MagicMock()
    mock_session.get.return_value = _resp("5.15", "N/A")
    mock_create_session.return_value = mock_session

    locations = {"CA": {"Danville": {"warehouse_id": "12345"}}}
    last_known = {"CA": {"Danville": [5.10, 5.60]}}
    result = get_gas_prices_ajax(locations, None, last_known)

    ts = next(iter(result))
    assert result[ts]["CA"]["Danville"] == [5.15, None]
    mock_session.get.assert_called_once()