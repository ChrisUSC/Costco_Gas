import json
from scraper import save_data


def test_save_data_carries_previous_price_forward(tmp_path):
    """Confirms *_latest.json now includes a 'previous' snapshot alongside
    'prices', which is what the frontend uses to render price trend arrows
    without loading the full history file."""
    history_file = tmp_path / "hist.json"
    latest_file = tmp_path / "latest.json"

    # First run: no prior latest file, so "previous" should be empty
    run1 = {"2026-07-01 09:00": {"CA": {"LA": [4.50, 4.80]}}}
    save_data(run1, str(history_file), str(latest_file))
    latest1 = json.loads(latest_file.read_text())
    assert latest1["prices"]["CA"]["LA"] == [4.50, 4.80]
    assert latest1["previous"] == {}

    # Second run: "previous" should now be exactly what "prices" was last run
    run2 = {"2026-07-01 10:00": {"CA": {"LA": [4.45, 4.75]}}}
    save_data(run2, str(history_file), str(latest_file))
    latest2 = json.loads(latest_file.read_text())
    assert latest2["prices"]["CA"]["LA"] == [4.45, 4.75]
    assert latest2["previous"]["CA"]["LA"] == [4.50, 4.80]

    # Third run: previous should now reflect run2's prices, not run1's
    run3 = {"2026-07-01 11:00": {"CA": {"LA": [4.40, 4.70]}}}
    save_data(run3, str(history_file), str(latest_file))
    latest3 = json.loads(latest_file.read_text())
    assert latest3["previous"]["CA"]["LA"] == [4.45, 4.75]