import unittest
from analyze_price_frequency import analyze


class TestAnalyzePriceFrequency(unittest.TestCase):
    def test_two_snapshots_with_deltas(self):
        """Simulates the GitHub Actions case: baseline with many stores, delta with a few."""
        history = {
            "2026-10-25 17:59": {
                "CA": {
                    f"Store {i}": [5.00, 5.50, None] for i in range(1, 20)
                }
            },
            "2026-10-26 04:13": {
                "CA": {
                    "Store 1": [5.05, 5.55, None],
                    "Store 2": [5.09, 5.59, None],
                }
            },
        }
        # Should not raise ZeroDivisionError or any other exception
        try:
            analyze(history, "test_ca_freq.json")
        except Exception as e:
            self.fail(f"analyze() raised an unexpected exception: {e}")

    def test_two_snapshots_zero_changes(self):
        """Ensures ZeroDivisionError is avoided when zero price changes occur."""
        history = {
            "2026-10-25 17:59": {"CA": {"Store A": [5.00, 5.50, None]}},
            "2026-10-26 04:13": {"CA": {"Store A": [5.00, 5.50, None]}},
        }
        try:
            analyze(history, "test_zero_changes.json")
        except Exception as e:
            self.fail(f"analyze() raised an unexpected exception: {e}")

    def test_flapping_detection(self):
        """Verifies oscillation detection (A -> B -> A) does not crash."""
        history = {
            "2026-10-25 17:59": {"CA": {"Store A": [5.00, 5.50, None]}},
            "2026-10-26 04:13": {"CA": {"Store A": [5.20, 5.70, None]}},
            "2026-10-26 06:00": {"CA": {"Store A": [5.00, 5.50, None]}},
        }
        try:
            analyze(history, "test_flapping.json")
        except Exception as e:
            self.fail(f"analyze() raised an unexpected exception: {e}")

    def test_single_snapshot(self):
        """Single snapshot should exit cleanly with a message and no error."""
        history = {"2026-10-25 17:59": {"CA": {"Store A": [5.00, 5.50, None]}}}
        try:
            analyze(history, "test_single.json")
        except Exception as e:
            self.fail(f"analyze() raised an unexpected exception: {e}")


if __name__ == "__main__":
    unittest.main()
