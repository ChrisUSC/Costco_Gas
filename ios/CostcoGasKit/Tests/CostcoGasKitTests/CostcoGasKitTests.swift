import XCTest
@testable import CostcoGasKit

// The same cases as tests/frontend/helpers.test.mjs, so the app and the website agree.

private func iso(_ s: String) -> Date {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)!
}

private func station(_ state: String = "CA", _ city: String = "Turlock", prices: GradePrices = GradePrices(regular: 4.45, premium: 4.85),
                     coordinate: LatLng? = LatLng(37.5091, -120.8466), hours: WeeklyHours? = nil, tz: String? = nil) -> Station {
    Station(state: state, city: city, address: "2500 GEER RD, TURLOCK, CA 95382", coordinate: coordinate,
            gasHours: hours, timeZone: tz, prices: prices)
}

final class PricesTests: XCTestCase {
    func testParsePrice() {
        XCTAssertEqual(parsePrice(4.45), 4.45)
        XCTAssertEqual(parsePrice("$4.45 "), 4.45)
        XCTAssertNil(parsePrice(nil))
        XCTAssertNil(parsePrice(NSNull()))
        XCTAssertNil(parsePrice("N/A"))
    }

    func testFormatPrice() {
        XCTAssertEqual(formatPrice(4.5), "$4.50")
        XCTAssertEqual(formatPrice(nil), "N/A")
        XCTAssertEqual(formatPrice(.nan), "N/A")
    }

    func testGradePricesParse() {
        XCTAssertEqual(GradePrices.parse([4.45, 4.85, 4.99]), GradePrices(regular: 4.45, premium: 4.85, diesel: 4.99))
        XCTAssertEqual(GradePrices.parse([4.45, 4.85]), GradePrices(regular: 4.45, premium: 4.85))
        XCTAssertEqual(GradePrices.parse(["Regular": 4.1, "premium": 4.5]), GradePrices(regular: 4.1, premium: 4.5))
        XCTAssertEqual(GradePrices.parse([4.45, NSNull(), NSNull()] as [Any]), GradePrices(regular: 4.45))
        XCTAssertNil(GradePrices.parse(nil))
    }

    func testDieselFilterAndVisibleGrades() {
        let withDiesel = station(prices: GradePrices(regular: 4, premium: 4.4, diesel: 5))
        let without = station("CA", "Tracy")
        XCTAssertEqual(StationQueries.forGrade([withDiesel, without], .diesel), [withDiesel])
        XCTAssertEqual(StationQueries.forGrade([withDiesel, without], .regular), [withDiesel, without])
        XCTAssertEqual(without.visibleGrades, [.regular, .premium])
        XCTAssertEqual(withDiesel.visibleGrades, [.regular, .premium, .diesel])
    }

    func testTrend() {
        XCTAssertEqual(Trend(current: 4.41, previous: 4.45), .down(cents: 4))
        XCTAssertEqual(Trend(current: 4.51, previous: 4.45), .up(cents: 6))
        XCTAssertEqual(Trend(current: 4.45, previous: 4.452), .flat)
        XCTAssertNil(Trend(current: 4.45, previous: nil))
        XCTAssertEqual(Trend.down(cents: 4).text, "▼ 4¢")
        XCTAssertEqual(Trend.down(cents: 4).accessibilityText(since: "72h ago"), "down 4 cents since 72h ago")
    }
}

final class StationTests: XCTestCase {
    func testMatches() {
        let s = station()
        XCTAssertTrue(s.matches("turl"))
        XCTAssertTrue(s.matches("geer"))
        XCTAssertTrue(s.matches("ca"))
        XCTAssertFalse(s.matches("austin"))
    }

    func testKeys() {
        XCTAssertEqual(station().id, "CA_Turlock")
        XCTAssertEqual(Station.parseKey("CA_South San Francisco")?.city, "South San Francisco")
        XCTAssertEqual(Station.parseKey("WA_Lake_Stevens")?.city, "Lake_Stevens")
        XCTAssertNil(Station.parseKey("nounderscore"))
    }

    func testDirectionsURLs() {
        let s = station()
        XCTAssertEqual(directionsURL(for: s, app: .google).absoluteString,
                       "https://www.google.com/maps/dir/?api=1&destination=37.5091%2C-120.8466")
        XCTAssertEqual(directionsURL(for: s, app: .apple).absoluteString,
                       "https://maps.apple.com/?daddr=37.5091%2C-120.8466&dirflg=d")
        XCTAssertEqual(directionsURL(for: s, app: .waze).absoluteString,
                       "https://waze.com/ul?ll=37.5091%2C-120.8466&navigate=yes")
        let noCoords = station(coordinate: nil)
        XCTAssertTrue(directionsURL(for: noCoords, app: .waze).absoluteString
            .hasPrefix("https://waze.com/ul?q=Costco%20Gas%2C%202500%20GEER"))
    }

    func testFormatAddress() {
        XCTAssertEqual(formatAddress("2207 W COMMONWEALTH AVE, ALHAMBRA, CA 91803-1302"),
                       "2207 W Commonwealth Ave, Alhambra, CA 91803-1302")
        XCTAssertEqual(formatAddress("100 4TH ST NE, MIAMI, FL 33101"), "100 4th St NE, Miami, FL 33101")
        XCTAssertEqual(formatAddress("Already Mixed, Case"), "Already Mixed, Case")
        XCTAssertEqual(formatAddress(nil), "")
    }

    func testBuildStationsFromJSON() throws {
        let stores = """
        {"CA": {"Turlock": {"lat": 37.5, "lng": -120.8, "address": "2500 GEER RD", "phone": "(209) 555-0100",
                  "gas_hours": {"mon": ["06:00", "22:00"], "sun": null}, "tz": "America/Los_Angeles"},
                "Tracy": {"lat": 37.7, "lng": -121.4, "address": "3250 W GRANT LINE RD"}},
         "NV": {"Reno": {"lat": 39.5, "lng": -119.8}}}
        """
        let latest = """
        {"timestamp": "2026-06-30 10:53", "previous_timestamp": "2026-06-27 10:53",
         "prices": {"CA": {"Turlock": [4.19, 4.59, null], "Tracy": [4.39, 4.79, 4.99]}},
         "previous": {"CA": {"Turlock": [4.23, 4.63, null]}}}
        """
        let directory = try StoreDirectory(data: Data(stores.utf8))
        let snapshot = try PriceSnapshot(data: Data(latest.utf8))
        let stations = buildStations(snapshot: snapshot, directory: directory)
        XCTAssertEqual(stations.map(\.id), ["CA_Tracy", "CA_Turlock"]) // NV has no prices
        let turlock = stations[1]
        XCTAssertEqual(turlock.price(.regular), 4.19)
        XCTAssertNil(turlock.price(.diesel))
        XCTAssertEqual(turlock.trend(.regular), .down(cents: 4))
        XCTAssertEqual(turlock.gasHours?["mon"], DayHours(open: "06:00", close: "22:00"))
        XCTAssertNil(turlock.gasHours?["sun"])
        XCTAssertEqual(turlock.phoneURL?.absoluteString, "tel:2095550100")
        XCTAssertNil(stations[0].trend(.regular))
    }

    func testDeepLinks() {
        let link = DeepLink(url: URL(string: "https://costco-gas.pages.dev/?store=CA_Turlock&tab=lowest&grade=diesel&state=TX")!)
        XCTAssertEqual(link, DeepLink(storeKey: "CA_Turlock", tab: "lowest", grade: .diesel, state: "TX"))
        let app = DeepLink(url: URL(string: "costcogas://open?tab=bogus&grade=jet&state=texas")!)
        XCTAssertEqual(app, DeepLink())
        XCTAssertNil(DeepLink(url: URL(string: "https://example.com/?store=CA_Turlock")!))
        XCTAssertEqual(DeepLink.shareURL(for: station("CA", "South San Francisco")).absoluteString,
                       "https://costco-gas.pages.dev/?store=CA_South%20San%20Francisco")
    }
}

final class LivePriceTests: XCTestCase {
    func testParseRoundsToCentsLikeTheScrapers() {
        let data = Data(#"{"146":{"premium":"5.599","regular":"4.999"}}"#.utf8)
        XCTAssertEqual(LivePriceService.parse(data), GradePrices(regular: 5.00, premium: 5.60))
        let diesel = Data(#"{"1":{"Regular":"$4.29","Premium":"4.69","Diesel":"4.99"}}"#.utf8)
        XCTAssertEqual(LivePriceService.parse(diesel), GradePrices(regular: 4.29, premium: 4.69, diesel: 4.99))
    }

    func testParseRejectsEmptyOrUnreadableReplies() {
        XCTAssertNil(LivePriceService.parse(Data(#"{"146":{"regular":"","premium":""}}"#.utf8)))
        XCTAssertNil(LivePriceService.parse(Data(#"{}"#.utf8)))
        XCTAssertNil(LivePriceService.parse(Data("<html>Access Denied</html>".utf8)))
    }

    func testURLAndWarehouseIDs() throws {
        let url = LivePriceService.url(warehouseID: "146").absoluteString
        XCTAssertTrue(url.hasPrefix("https://www.costco.com/AjaxGetGasPricesService?warehouseid=146&_="))
        let stores = #"{"CA": {"Livermore": {"warehouse_id": "146"}, "Tracy": {"warehouse_id": 1234}}}"#
        let directory = try StoreDirectory(data: Data(stores.utf8))
        XCTAssertEqual(directory.states["CA"]?["Livermore"]?.warehouseID, "146")
        XCTAssertEqual(directory.states["CA"]?["Tracy"]?.warehouseID, "1234")
    }
}

final class GeoTests: XCTestCase {
    func testDistance() {
        let d = distanceMiles(LatLng(34.0522, -118.2437), LatLng(37.7749, -122.4194))
        XCTAssertEqual(d, 347, accuracy: 3)
        XCTAssertEqual(distanceMiles(LatLng(37, -120), LatLng(37, -120)), 0)
    }

    func testSegmentDistance() {
        XCTAssertEqual(distanceToSegmentMiles(LatLng(1, 0.5), LatLng(0, 0), LatLng(0, 1)), 69.1, accuracy: 0.5)
        XCTAssertEqual(distanceToSegmentMiles(LatLng(0, 2), LatLng(0, 0), LatLng(0, 1)),
                       distanceMiles(LatLng(0, 2), LatLng(0, 1)), accuracy: 0.01)
        XCTAssertEqual(distanceToSegmentMiles(LatLng(1, 0), LatLng(0, 0), LatLng(0, 0)),
                       distanceMiles(LatLng(1, 0), LatLng(0, 0)), accuracy: 0.01)
    }

    func testRouteDistanceAndBounds() {
        let route = [LatLng(0, 0), LatLng(0, 1), LatLng(1, 1)]
        XCTAssertLessThan(minDistanceToRouteMiles(LatLng(0.5, 1), route), 0.01)
        XCTAssertEqual(minDistanceToRouteMiles(LatLng(1, 0), [LatLng(0, 0)]), distanceMiles(LatLng(1, 0), LatLng(0, 0)))
        let b = routeBoundsPadded([LatLng(37, -121), LatLng(38, -120)], bufferMiles: 69)
        XCTAssertEqual(b.minLat, 36, accuracy: 1e-9)
        XCTAssertEqual(b.maxLat, 39, accuracy: 1e-9)
        XCTAssertGreaterThan(-121 - b.minLng, 1)
        XCTAssertGreaterThan(b.maxLng - -120, 1)
    }
}

final class GasHoursTests: XCTestCase {
    // 2026-06-29 is a Monday; Pacific time is UTC-7 in summer.
    let hours: WeeklyHours = [
        "mon": DayHours(open: "06:00", close: "22:00"), "tue": DayHours(open: "06:00", close: "22:00"),
        "wed": DayHours(open: "06:00", close: "22:00"), "thu": DayHours(open: "06:00", close: "22:00"),
        "fri": DayHours(open: "06:00", close: "02:00"), "sat": DayHours(open: "00:00", close: "00:00")
    ]
    func status(_ isoTime: String, tz: String = "America/Los_Angeles") -> GasStatus? {
        GasHours.status(hours: hours, timeZone: tz, now: iso(isoTime))
    }

    func testFormatTime() {
        XCTAssertEqual(GasHours.formatTime("06:00"), "6 AM")
        XCTAssertEqual(GasHours.formatTime("20:30"), "8:30 PM")
        XCTAssertEqual(GasHours.formatTime("00:00"), "12 AM")
        XCTAssertEqual(GasHours.formatTime("12:15"), "12:15 PM")
    }

    func testOpenClosingSoonClosed() {
        XCTAssertEqual(status("2026-06-29T12:00:00-07:00"), GasStatus(isOpen: true, closingSoon: false, text: "Open · closes 10 PM"))
        XCTAssertEqual(status("2026-06-29T21:15:00-07:00"), GasStatus(isOpen: true, closingSoon: true, text: "Closing soon · 10 PM"))
        XCTAssertEqual(status("2026-06-29T05:00:00-07:00"), GasStatus(isOpen: false, closingSoon: false, text: "Closed · opens 6 AM"))
        XCTAssertEqual(status("2026-06-29T23:00:00-07:00")?.text, "Closed · opens tomorrow 6 AM")
    }

    func testPastMidnight24HoursAndClosedDays() {
        XCTAssertEqual(status("2026-07-03T23:30:00-07:00")?.text, "Open · closes 2 AM tomorrow")
        XCTAssertEqual(status("2026-07-04T01:00:00-07:00")?.text, "Closing soon · 2 AM")
        XCTAssertEqual(status("2026-07-04T15:00:00-07:00")?.text, "Open 24 hours")
        XCTAssertEqual(status("2026-07-05T10:00:00-07:00")?.text, "Closed · opens tomorrow 6 AM")
    }

    func testStationTimeZone() {
        XCTAssertEqual(status("2026-06-29T20:30:00-07:00", tz: "America/New_York")?.isOpen, false)
        XCTAssertEqual(status("2026-06-29T20:30:00-07:00")?.isOpen, true)
    }

    func testNoStatusWithoutHoursOrZone() {
        XCTAssertNil(GasHours.status(hours: nil, timeZone: "America/Los_Angeles"))
        XCTAssertNil(GasHours.status(hours: hours, timeZone: nil))
    }

    func testGrouped() {
        XCTAssertEqual(GasHours.grouped(hours), [
            GasHours.Row(label: "Mon–Thu", text: "6 AM – 10 PM"),
            GasHours.Row(label: "Fri", text: "6 AM – 2 AM"),
            GasHours.Row(label: "Sat", text: "12 AM – 12 AM"),
            GasHours.Row(label: "Sun", text: "Closed")
        ])
    }
}

final class ScraperTimeTests: XCTestCase {
    func testParsePacificWallClock() {
        XCTAssertEqual(ScraperTime.parse("2026-06-30 10:53"), iso("2026-06-30T17:53:00Z"))
        XCTAssertEqual(ScraperTime.parse("2026-01-15 08:00"), iso("2026-01-15T16:00:00Z"))
        XCTAssertEqual(ScraperTime.parse("2026-06-30T10:53:00Z"), iso("2026-06-30T10:53:00Z"))
        XCTAssertNil(ScraperTime.parse(""))
        XCTAssertNil(ScraperTime.parse("not a date"))
    }

    func testUpdatedLabel() {
        let now = iso("2026-06-30T11:00:00-07:00")
        XCTAssertEqual(ScraperTime.updatedLabel("2026-06-30 11:00", now: now).text, "Updated just now")
        XCTAssertEqual(ScraperTime.updatedLabel("2026-06-30 10:35", now: now).text, "Updated 25 min ago")
        let twoHours = ScraperTime.updatedLabel("2026-06-30 09:00", now: now)
        XCTAssertEqual(twoHours.text, "Updated 2 hr ago")
        XCTAssertFalse(twoHours.stale)
        XCTAssertFalse(ScraperTime.updatedLabel("2026-06-30 07:01", now: now).stale)
        let stale = ScraperTime.updatedLabel("2026-06-30 07:00", now: now)
        XCTAssertTrue(stale.stale)
        XCTAssertEqual(stale.text, "Updated 4 hr ago · may be out of date")
        XCTAssertTrue(stale.detail.contains("may be out of date"))
        XCTAssertEqual(ScraperTime.updatedLabel("2026-06-27 11:00", now: now).text, "Updated 3 days ago · may be out of date")
        XCTAssertEqual(ScraperTime.updatedLabel(nil, now: now).text, "Update time unknown")
        XCTAssertFalse(ScraperTime.updatedLabel(nil, now: now).stale)
    }

    func testRelativeLabel() {
        let now = iso("2026-06-30T11:00:00-07:00")
        XCTAssertEqual(ScraperTime.relativeLabel("2026-06-30 10:45", now: now), "the last hour")
        XCTAssertEqual(ScraperTime.relativeLabel("2026-06-29 11:00", now: now), "24h ago")
        XCTAssertEqual(ScraperTime.relativeLabel("2026-06-27 11:00", now: now), "3d ago")
        XCTAssertEqual(ScraperTime.relativeLabel(nil, now: now), "the last update")
    }
}

final class QueriesTests: XCTestCase {
    let home = LatLng(37.5, -120.85)
    lazy var near = station("CA", "Near", prices: GradePrices(regular: 4.50), coordinate: LatLng(37.51, -120.85))
    lazy var cheapFar = station("CA", "CheapFar", prices: GradePrices(regular: 4.10), coordinate: LatLng(37.6, -120.85))
    lazy var outside = station("CA", "Outside", prices: GradePrices(regular: 3.00), coordinate: LatLng(39, -120.85))
    lazy var noPrice = station("CA", "NoPrice", prices: GradePrices(), coordinate: LatLng(37.5, -120.86))

    func testNearbySorting() {
        let within = StationQueries.within([near, cheapFar, outside, noPrice], of: home, radiusMiles: 10)
        XCTAssertEqual(Set(within.map(\.id)), ["CA_Near", "CA_CheapFar", "CA_NoPrice"])
        XCTAssertEqual(StationQueries.sortNearby(within, grade: .regular, by: .price).map(\.id), ["CA_CheapFar", "CA_Near"])
        XCTAssertEqual(StationQueries.sortNearby(within, grade: .regular, by: .distance).map(\.id), ["CA_Near", "CA_CheapFar"])
    }

    func testLowestStatesAndClosestState() {
        let tx = station("TX", "Austin", prices: GradePrices(regular: 2.9), coordinate: LatLng(30.27, -97.74))
        let all = [near, cheapFar, tx]
        XCTAssertEqual(StationQueries.lowest(all, state: "CA", grade: .regular).map(\.city), ["CheapFar", "Near"])
        XCTAssertEqual(StationQueries.states(all), [StateCount(code: "CA", count: 2), StateCount(code: "TX", count: 1)])
        XCTAssertEqual(StationQueries.closestState(to: LatLng(30, -97), in: all), "TX")
    }

    func testAlongRoute() {
        let route = [LatLng(37.5, -121), LatLng(37.5, -120)]
        let along = StationQueries.along(route: route, stations: [near, cheapFar, outside], bufferMiles: 2)
        XCTAssertEqual(along.map(\.id), ["CA_Near"])
    }

    func testPriceTiers() {
        let scale = PriceTierScale(pricesInView: [4.0, 4.3, 4.6], enabled: true)
        XCTAssertTrue(scale.comparable)
        XCTAssertEqual(scale.tier(for: 4.0), .low)
        XCTAssertEqual(scale.tier(for: 4.3), .mid)
        XCTAssertEqual(scale.tier(for: 4.6), .high)
        XCTAssertEqual(scale.tier(for: nil), .none)
        XCTAssertFalse(PriceTierScale(pricesInView: [4.0, 4.01, 4.02], enabled: true).comparable)
        XCTAssertFalse(PriceTierScale(pricesInView: [4.0, 4.3], enabled: true).comparable)
        XCTAssertEqual(PriceTierScale(pricesInView: [4.0, 4.3, 4.6], enabled: false).tier(for: 4.0), .flat)
    }
}

final class HistoryTests: XCTestCase {
    var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return c
    }()

    func testParseChangeOnlyHistory() throws {
        let json = """
        {"2026-06-10 09:00": {"CA": {"Turlock": [4.39, 4.79, null], "Tracy": [4.5, 4.9, 4.99]}},
         "2026-06-20 09:00": {"CA": {"Turlock": [4.19, 4.59, null]}},
         "2026-06-28 09:00": {"CA": {"Turlock": [4.00, 4.40, null]}}}
        """
        let history = try PriceHistory(data: Data(json.utf8))
        XCTAssertEqual(history.points(for: "CA_Turlock").map(\.prices.regular), [4.39, 4.19, 4.00])
        XCTAssertEqual(history.points(for: "CA_Tracy").count, 1)
        XCTAssertTrue(history.points(for: "CA_Nowhere").isEmpty)
    }

    func testDailySeriesCarriesPricesForwardAndMarksChanges() {
        let points = [
            HistoryPoint(date: iso("2026-06-10T09:00:00-07:00"), prices: GradePrices(regular: 4.39)),
            HistoryPoint(date: iso("2026-06-20T08:00:00-07:00"), prices: GradePrices(regular: 4.29)),
            HistoryPoint(date: iso("2026-06-20T18:00:00-07:00"), prices: GradePrices(regular: 4.19)),
            HistoryPoint(date: iso("2026-06-28T09:00:00-07:00"), prices: GradePrices(regular: 4.00))
        ]
        let now = iso("2026-06-30T11:00:00-07:00")
        let week = PriceHistory.dailySeries(points, rangeDays: 7, now: now, calendar: calendar)
        XCTAssertEqual(week.count, 8) // June 23 … June 30
        XCTAssertEqual(week.first?.prices.regular, 4.19) // carried in from before the range
        XCTAssertEqual(week.first?.changed, [])
        let june28 = week.first { calendar.component(.day, from: $0.date) == 28 }
        XCTAssertEqual(june28?.changed, [.regular])
        XCTAssertEqual(week.last?.prices.regular, 4.00)

        let all = PriceHistory.dailySeries(points, rangeDays: 0, now: now, calendar: calendar)
        XCTAssertEqual(all.count, 21) // June 10 … June 30
        let june20 = all.first { calendar.component(.day, from: $0.date) == 20 }
        XCTAssertEqual(june20?.prices.regular, 4.19) // the last entry of the day wins
    }

    func testOsrmAndNominatimDecoding() throws {
        let osrm = #"{"code":"Ok","routes":[{"distance":64373.6,"geometry":{"type":"LineString","coordinates":[[-120.8,37.5],[-121.4,37.7]]}}]}"#
        let route = try RouteService.decode(Data(osrm.utf8))
        XCTAssertEqual(route.coords, [LatLng(37.5, -120.8), LatLng(37.7, -121.4)])
        XCTAssertEqual(route.distanceMiles, 40, accuracy: 0.01)
        XCTAssertFalse(route.isApproximate)
        XCTAssertThrowsError(try RouteService.decode(Data(#"{"code":"NoRoute"}"#.utf8)))

        let nominatim = """
        [{"lat":"37.49","lon":"-120.84","display_name":"Turlock, Stanislaus County, California, United States",
          "type":"city","addresstype":"city","osm_id":1,"address":{"city":"Turlock","state":"California","ISO3166-2-lvl4":"US-CA"}},
         {"lat":"37.5","lon":"-120.8","display_name":"95380, Turlock","addresstype":"postcode",
          "address":{"postcode":"95380","city":"Turlock","ISO3166-2-lvl4":"US-CA"}},
         {"lat":"37.5","lon":"-120.8","display_name":"x","addresstype":"house",
          "address":{"house_number":"2500","road":"Geer Road","city":"Turlock","state":"California"}}]
        """
        let results = try Geocoder.decode(Data(nominatim.utf8))
        XCTAssertEqual(results.map(\.place.label), ["Turlock, CA", "95380 — Turlock, CA", "2500 Geer Road, Turlock, California"])
        XCTAssertEqual(results.map(\.kind), ["City", "Zip Code", "Address"])
        XCTAssertEqual(Geocoder.parseCoordinates("37.5, -120.8"), Place(lat: 37.5, lng: -120.8, label: "37.5, -120.8"))
        XCTAssertNil(Geocoder.parseCoordinates("Turlock, CA"))
    }

    func testSnapshotClientFallsBackToSavedCopy() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        // Port 9 on localhost refuses connections, so the network fetch fails at once.
        let client = SnapshotClient(baseURL: URL(string: "http://127.0.0.1:9/")!, directory: dir)
        await XCTAssertThrowsErrorAsync { _ = try await client.fetch("us_latest.json", cacheBuster: "1") }
        client.save(Data("{}".utf8), as: "us_latest.json")
        let result = try await client.fetch("us_latest.json", cacheBuster: "1")
        XCTAssertTrue(result.fromSavedCopy)
        XCTAssertEqual(result.data, Data("{}".utf8))
    }
}

private func XCTAssertThrowsErrorAsync(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
    do {
        try await body()
        XCTFail("expected an error", file: file, line: line)
    } catch {}
}
