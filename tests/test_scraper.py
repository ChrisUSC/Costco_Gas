import json
import requests
from unittest.mock import patch, MagicMock

# Import the functions from your script (assuming it is named scraper.py)
from scraper import (
    format_price,
    get_warehouse_id,
    extract_store_metadata,
    load_store_locations,
    save_data,
    write_pretty_top_level,
    remove_location_from_file,
    get_gas_prices_ajax,
    extract_stores_from_html
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