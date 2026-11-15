import json
from scraper import (
    compute_price_deltas,
    reconstruct_store_prices_at,
    find_trend_baseline,
    save_data
)


def test_compute_price_deltas():
    last_known = {
        "CA": {
            "Tracy": [4.29, 4.89, None],
            "Modesto": [4.19, 4.79, None],
        },
        "AZ": {
            "Phoenix": [3.89, 4.39, None],
        }
    }

    # Only Modesto changed; Tracy and Phoenix stayed identical
    new_prices = {
        "CA": {
            "Tracy": [4.29, 4.89, None],
            "Modesto": [4.15, 4.75, None],
        },
        "AZ": {
            "Phoenix": [3.89, 4.39, None],
        }
    }

    deltas = compute_price_deltas(new_prices, last_known)
    assert "AZ" not in deltas
    assert "Tracy" not in deltas["CA"]
    assert deltas["CA"]["Modesto"] == [4.15, 4.75, None]


def test_reconstruct_store_prices_at_with_deltas():
    # History with 3 sparse delta snapshots
    history = {
        "2026-10-01 10:00": {
            "CA": {
                "Tracy": [4.50, 4.90, None],
                "Modesto": [4.40, 4.80, None],
            }
        },
        "2026-10-05 10:00": {
            "CA": {
                # Only Tracy changed here
                "Tracy": [4.45, 4.85, None],
            }
        },
        "2026-10-10 10:00": {
            "CA": {
                # Only Modesto changed here
                "Modesto": [4.30, 4.70, None],
            }
        }
    }

    # Reconstruct at Oct 06: Tracy should be 4.45, Modesto should still be 4.40
    oct06 = reconstruct_store_prices_at(history, "2026-10-06 12:00")
    assert oct06["CA"]["Tracy"] == [4.45, 4.85, None]
    assert oct06["CA"]["Modesto"] == [4.40, 4.80, None]

    # Reconstruct at Oct 12: Tracy should be 4.45, Modesto should be 4.30
    oct12 = reconstruct_store_prices_at(history, "2026-10-12 12:00")
    assert oct12["CA"]["Tracy"] == [4.45, 4.85, None]
    assert oct12["CA"]["Modesto"] == [4.30, 4.70, None]


def test_save_data_skips_appending_when_no_change(tmp_path):
    history_file = tmp_path / "hist.json"
    latest_file = tmp_path / "latest.json"

    initial_run = {"2026-10-01 10:00": {"CA": {"LA": [4.50, 4.80, None]}}}
    save_data(initial_run, str(history_file), str(latest_file))

    content1 = json.loads(history_file.read_text())
    assert "2026-10-01 10:00" in content1
    assert len(content1) == 1

    # Second run with exact same prices
    second_run = {"2026-10-01 18:00": {"CA": {"LA": [4.50, 4.80, None]}}}
    save_data(second_run, str(history_file), str(latest_file))

    content2 = json.loads(history_file.read_text())
    # History file should NOT have appended 18:00 because prices didn't change!
    assert len(content2) == 1
    assert "2026-10-01 18:00" not in content2

    # Latest file should still update its scrape timestamp
    latest2 = json.loads(latest_file.read_text())
    assert latest2["timestamp"] == "2026-10-01 18:00"
    assert latest2["prices"]["CA"]["LA"] == [4.50, 4.80, None]


def test_find_trend_baseline_with_deltas():
    # Delta history across 4 days
    history = {
        "2026-10-01 10:00": {
            "CA": {
                "Tracy": [4.50, 4.90, None],
                "Modesto": [4.40, 4.80, None],
            }
        },
        "2026-10-02 10:00": {
            "CA": {
                "Tracy": [4.45, 4.85, None],
            }
        },
        "2026-10-04 10:00": {
            "CA": {
                "Modesto": [4.35, 4.75, None],
            }
        }
    }

    # At 2026-10-04 10:00, 72h prior was 2026-10-01 10:00
    baseline_prices, baseline_ts = find_trend_baseline(history, "2026-10-04 10:00")
    assert baseline_ts == "2026-10-01 10:00"
    assert baseline_prices["CA"]["Tracy"] == [4.50, 4.90, None]
    assert baseline_prices["CA"]["Modesto"] == [4.40, 4.80, None]


def test_small_change_triggers_confirmation(monkeypatch):
    import scraper

    # Mock response from attempt_fetch
    call_count = 0
    def mock_session_get(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        class MockResp:
            def raise_for_status(self): pass
            def json(self):
                # First call returns new price 4.45 (old was 4.49, jump is only $0.04)
                return {"1": {"regular": "$4.45", "premium": "$4.89", "diesel": "N/A"}}
        return MockResp()

    monkeypatch.setattr("scraper.create_session", lambda: type("Session", (), {"get": mock_session_get})())
    # Speed up delay during rechecks
    monkeypatch.setattr(scraper, "RECHECK_DELAY_RANGE", (0.01, 0.02))

    confirm_called = False
    orig_confirm = scraper.confirm_or_revert_price
    def mock_confirm(*args, **kwargs):
        nonlocal confirm_called
        confirm_called = True
        return orig_confirm(*args, **kwargs)

    monkeypatch.setattr(scraper, "confirm_or_revert_price", mock_confirm)

    locations = {"CA": {"Fresno": {"warehouse_id": "1"}}}
    last_known = {"CA": {"Fresno": [4.49, 4.89, None]}}

    # Even a $0.04 move triggers confirmation re-checks
    result = scraper.get_gas_prices_ajax(
        locations,
        last_known_prices=last_known,
    )
    assert confirm_called is True
    ts = next(iter(result))
    # Confirmed new price since rechecks agreed on 4.45
    assert result[ts]["CA"]["Fresno"] == [4.45, 4.89, None]
    assert call_count >= 4


def test_small_glitch_reverts_to_last_known(monkeypatch):
    import scraper

    # First fetch returns glitch (4.45), rechecks return actual price (4.49)
    responses = [
        {"1": {"regular": "$4.45", "premium": "$4.89", "diesel": "N/A"}},  # Initial glitch
        {"1": {"regular": "$4.49", "premium": "$4.89", "diesel": "N/A"}},  # Recheck 1
        {"1": {"regular": "$4.49", "premium": "$4.89", "diesel": "N/A"}},  # Recheck 2
        {"1": {"regular": "$4.49", "premium": "$4.89", "diesel": "N/A"}},  # Recheck 3
    ]
    call_idx = 0
    def mock_session_get(*args, **kwargs):
        nonlocal call_idx
        resp_data = responses[min(call_idx, len(responses) - 1)]
        call_idx += 1
        class MockResp:
            def raise_for_status(self): pass
            def json(self): return resp_data
        return MockResp()

    monkeypatch.setattr("scraper.create_session", lambda: type("Session", (), {"get": mock_session_get})())
    monkeypatch.setattr(scraper, "RECHECK_DELAY_RANGE", (0.01, 0.02))

    locations = {"CA": {"Fresno": {"warehouse_id": "1"}}}
    last_known = {"CA": {"Fresno": [4.49, 4.89, None]}}

    result = scraper.get_gas_prices_ajax(
        locations,
        last_known_prices=last_known,
    )
    ts = next(iter(result))
    # Reverted back to 4.49!
    assert result[ts]["CA"]["Fresno"] == [4.49, 4.89, None]
    assert call_idx >= 4