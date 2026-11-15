import json
import scraper as s

# Visible text as rendered on https://www.costco.com/w/-/ca/turlock/782
TURLOCK_HTML = """<html><body><div>Turlock Warehouse Open until 7PM
Hours Executive Member Hours Mon-Fri: 9:00 AM - 8:30 PM Sat-Sun: 9:00 AM - 7:00 PM
Warehouse Services
<div>Gas Station</div><div>Mon-Fri:</div><div>6:00 AM - 10:00 PM</div>
<div>Sat:</div><div>6:00 AM - 8:30 PM</div><div>Sun:</div><div>6:00 AM - 8:00 PM</div>
<p>Prices shown here are updated frequently, but may not reflect the price at the pump.</p>
<div>Pharmacy Mon-Fri: 9:00 AM - 7:00 PM Sat: 9:00 AM - 6:00 PM Sun: Closed</div>
<div>Car Wash Mon-Fri: 7:00 AM - 8:30 PM Sat-Sun: 7:00 AM - 7:00 PM</div>
</div></body></html>"""

EXPECTED = {
    **{d: ["06:00", "22:00"] for d in ("mon", "tue", "wed", "thu", "fri")},
    "sat": ["06:00", "20:30"], "sun": ["06:00", "20:00"],
}

def test_html_fallback_uses_gas_block_not_warehouse_or_pharmacy():
    assert s.extract_gas_hours(TURLOCK_HTML) == EXPECTED

def test_jsonld_preferred_when_present():
    ld = {"department": [{"@type": "GasStation", "openingHoursSpecification": [
        {"dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], "opens": "06:00", "closes": "22:00"},
        {"dayOfWeek": "https://schema.org/Saturday", "opens": "06:00", "closes": "20:30"},
        {"dayOfWeek": "Sunday", "opens": "06:00", "closes": "20:00"}]}]}
    assert s.extract_gas_hours("<html></html>", ld) == EXPECTED

def test_closed_day_parses_as_none():
    text = "Mon-Sat: 6:00 AM - 8:00 PM Sun: Closed"
    assert s.parse_hours_text(text)["sun"] is None

def test_incomplete_schedule_returns_none():
    assert s.parse_hours_text("Mon-Fri: 6:00 AM - 10:00 PM") is None

def test_noon_and_midnight_conversion():
    assert s._to_24h("12:00 PM") == "12:00" and s._to_24h("12:00 AM") == "00:00"

def test_metadata_includes_hours_and_phone_and_stays_backward_compatible():
    ld = {"@type": "LocalBusiness", "telephone": "(209) 656-5301",
          "geo": {"latitude": "37.5", "longitude": "-120.9"},
          "address": {"streetAddress": "2955 N TEGNER RD", "addressLocality": "TURLOCK",
                      "addressRegion": "CA", "postalCode": "95380"},
          "department": [{"@type": "GasStation"}]}
    html = f'<html><script type="application/ld+json">{json.dumps(ld)}</script>{TURLOCK_HTML}</html>'
    meta = s.extract_store_metadata(html)
    assert meta["has_gas"] and meta["lat"] == 37.5 and meta["phone"] == "(209) 656-5301"
    assert meta["gas_hours"] == EXPECTED

def test_no_gas_hours_means_key_absent():
    ld = {"@type": "LocalBusiness", "geo": {"latitude": "1", "longitude": "2"}, "address": {}, "department": []}
    meta = s.extract_store_metadata(f'<script type="application/ld+json">{json.dumps(ld)}</script>')
    assert "gas_hours" not in meta

def test_refresh_is_additive_and_keeps_stores_on_failure(tmp_path, monkeypatch):
    stores = {"CA": {"Turlock": {"url": "u1", "warehouse_id": "782", "lat": 1, "lng": 2, "address": "a"},
                     "Broken": {"url": "u2", "warehouse_id": "1", "lat": 1, "lng": 2, "address": "b"}}}
    class R:
        def __init__(self, ok): self.ok = ok; self.text = ""
        def raise_for_status(self):
            if not self.ok: raise s.requests.exceptions.RequestException("boom")
    class Sess:
        def get(self, url, **_): return R(url == "u1")
    monkeypatch.setattr(s, "create_session", lambda: Sess())
    monkeypatch.setattr(s, "extract_store_metadata", lambda html: {"gas_hours": EXPECTED, "phone": "x"})
    path = tmp_path / "stores.json"
    assert s.refresh_store_details(stores, str(path)) == 2
    saved = json.loads(path.read_text())
    assert saved["CA"]["Turlock"]["gas_hours"] == EXPECTED
    assert "gas_hours" not in saved["CA"]["Broken"] and saved["CA"]["Broken"]["url"] == "u2"
