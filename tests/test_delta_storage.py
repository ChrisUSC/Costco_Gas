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
    save_data(initial_run, str(history_file), str(latest_file), delta_mode=True)

    content1 = json.loads(history_file.read_text())
    assert "2026-10-01 10:00" in content1
    assert len(content1) == 1

    # Second run with exact same prices
    second_run = {"2026-10-01 18:00": {"CA": {"LA": [4.50, 4.80, None]}}}
    save_data(second_run, str(history_file), str(latest_file), delta_mode=True)

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


def test_migrate_history_to_delta_lossless():
    from migrate_history_to_delta import convert_to_delta, verify_lossless

    dummy_history = {
        "2026-10-01 08:00": {
            "CA": {"Tracy": [4.50, 4.90, None], "Modesto": [4.40, 4.80, None]}
        },
        "2026-10-01 16:00": {
            "CA": {"Tracy": [4.50, 4.90, None], "Modesto": [4.40, 4.80, None]}  # No change
        },
        "2026-10-02 08:00": {
            "CA": {"Tracy": [4.45, 4.85, None], "Modesto": [4.40, 4.80, None]}  # Tracy changed
        },
        "2026-10-02 16:00": {
            "CA": {"Tracy": [4.45, 4.85, None], "Modesto": [4.35, 4.75, None]}  # Modesto changed
        }
    }

    delta_hist, total_orig, total_delta = convert_to_delta(dummy_history)
    assert len(delta_hist) == 3  # 16:00 on Oct 01 had 0 changes, so it was omitted
    assert "2026-10-01 16:00" not in delta_hist
    assert verify_lossless(dummy_history, delta_hist) is True


def test_ca_frequency_runner(tmp_path, monkeypatch):
    import ca_frequency_runner

    # This test covers "latest.json timestamp = last check" mode.
    monkeypatch.setattr(ca_frequency_runner, "WRITE_LATEST_ONLY_ON_CHANGE", False)

    stores_file = tmp_path / "ca_stores.json"
    hist_file = tmp_path / "ca_freq_history.json"
    latest_file = tmp_path / "ca_freq_latest.json"

    stores_file.write_text(json.dumps({"CA": {"Fresno": "https://costco.com/AjaxGetGasPricesService?warehouseid=1"}}))

    mock_prices = {
        "2026-10-25 10:00": {
            "CA": {"Fresno": [4.15, 4.55, None]}
        }
    }
    monkeypatch.setattr(ca_frequency_runner, "get_gas_prices_ajax", lambda *args, **kwargs: mock_prices)

    # First run: seed baseline
    ok = ca_frequency_runner.run_ca_tracker(str(stores_file), str(hist_file), str(latest_file))
    assert ok is True
    hist_data = json.loads(hist_file.read_text())
    assert "2026-10-25 10:00" in hist_data
    assert hist_data["2026-10-25 10:00"]["CA"]["Fresno"] == [4.15, 4.55, None]

    # Second run: same prices, should skip appending to history
    mock_prices2 = {
        "2026-10-25 12:00": {
            "CA": {"Fresno": [4.15, 4.55, None]}
        }
    }
    monkeypatch.setattr(ca_frequency_runner, "get_gas_prices_ajax", lambda *args, **kwargs: mock_prices2)
    ok2 = ca_frequency_runner.run_ca_tracker(str(stores_file), str(hist_file), str(latest_file))
    assert ok2 is True
    hist_data2 = json.loads(hist_file.read_text())
    assert len(hist_data2) == 1
    assert "2026-10-25 12:00" not in hist_data2

    latest_data = json.loads(latest_file.read_text())
    assert latest_data["timestamp"] == "2026-10-25 12:00"


def test_ca_frequency_runner_latest_only_written_on_change(tmp_path, monkeypatch):
    import ca_frequency_runner

    monkeypatch.setattr(ca_frequency_runner, "WRITE_LATEST_ONLY_ON_CHANGE", True)

    stores_file = tmp_path / "ca_stores.json"
    hist_file = tmp_path / "ca_freq_history.json"
    latest_file = tmp_path / "ca_freq_latest.json"
    stores_file.write_text(json.dumps({"CA": {"Fresno": {"warehouse_id": "1"}}}))

    def run(ts, prices):
        mock = {ts: {"CA": {"Fresno": prices}}}
        monkeypatch.setattr(ca_frequency_runner, "get_gas_prices_ajax", lambda *a, **k: mock)
        return ca_frequency_runner.run_ca_tracker(str(stores_file), str(hist_file), str(latest_file))

    assert run("2026-10-25 10:00", [4.15, 4.55, None]) is True      # seed
    assert run("2026-10-25 12:00", [4.15, 4.55, None]) is True      # no change
    latest = json.loads(latest_file.read_text())
    assert latest["timestamp"] == "2026-10-25 10:00"                  # untouched

    assert run("2026-10-25 14:00", [4.10, 4.55, None]) is True      # price moved
    latest = json.loads(latest_file.read_text())
    assert latest["timestamp"] == "2026-10-25 14:00"
    hist = json.loads(hist_file.read_text())
    assert hist["2026-10-25 14:00"]["CA"]["Fresno"] == [4.10, 4.55, None]


def test_ca_frequency_runner_aborts_on_corrupt_history(tmp_path, monkeypatch):
    import ca_frequency_runner

    stores_file = tmp_path / "ca_stores.json"
    hist_file = tmp_path / "ca_freq_history.json"
    latest_file = tmp_path / "ca_freq_latest.json"
    stores_file.write_text(json.dumps({"CA": {"Fresno": {"warehouse_id": "1"}}}))
    hist_file.write_text("{ not json")

    mock = {"2026-10-25 10:00": {"CA": {"Fresno": [4.15, 4.55, None]}}}
    monkeypatch.setattr(ca_frequency_runner, "get_gas_prices_ajax", lambda *a, **k: mock)

    assert ca_frequency_runner.run_ca_tracker(str(stores_file), str(hist_file), str(latest_file)) is False
    assert hist_file.read_text() == "{ not json"   # real history was not overwritten


def test_verify_all_changes_triggers_confirmation(monkeypatch):
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

    # With verify_all_changes=True, even a $0.04 move triggers confirmation re-checks
    result = scraper.get_gas_prices_ajax(
        locations,
        last_known_prices=last_known,
        verify_all_changes=True,
    )
    assert confirm_called is True
    ts = next(iter(result))
    # Confirmed new price since rechecks agreed on 4.45
    assert result[ts]["CA"]["Fresno"] == [4.45, 4.89, None]
    assert call_count >= 4


def test_verify_all_changes_reverts_glitch_to_last_known(monkeypatch):
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
        verify_all_changes=True,
    )
    ts = next(iter(result))
    # Reverted back to 4.49!
    assert result[ts]["CA"]["Fresno"] == [4.49, 4.89, None]
    assert call_idx >= 4