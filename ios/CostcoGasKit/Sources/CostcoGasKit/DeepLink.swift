import Foundation

// --- Shareable links: the website's ?store=, ?tab=, ?grade= and ?state= (public/js/nav.js) ---

public struct DeepLink: Equatable, Sendable {
    public static let scheme = "costcogas"
    public static let tabNames = ["nearby", "lowest", "route", "search", "favorites"]

    public var storeKey: String?
    public var tab: String?
    public var grade: Grade?
    public var state: String?

    public init(storeKey: String? = nil, tab: String? = nil, grade: Grade? = nil, state: String? = nil) {
        self.storeKey = storeKey
        self.tab = tab
        self.grade = grade
        self.state = state
    }

    /// Reads `costcogas://open?store=CA_Turlock` or a website link such as
    /// `https://costco-gas.pages.dev/?store=CA_Turlock&grade=diesel`. Unknown values are dropped.
    public init?(url: URL) {
        let isApp = url.scheme?.lowercased() == DeepLink.scheme
        let isSite = url.host?.lowercased() == siteURL.host
        guard isApp || isSite, let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let items = comps.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value.flatMap { $0.isEmpty ? nil : $0 }
        }
        storeKey = value("store").flatMap { Station.parseKey($0) != nil ? $0 : nil }
        tab = value("tab").flatMap { DeepLink.tabNames.contains($0) ? $0 : nil }
        grade = value("grade").flatMap(Grade.init(rawValue:))
        state = value("state").flatMap { s in
            s.count == 2 && s.allSatisfy({ ("A"..."Z").contains($0) }) ? s : nil
        }
    }

    /// A website link to the station: opens the station on the site, or in the app if installed.
    public static func shareURL(for station: Station, base: URL = siteURL) -> URL {
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "store", value: station.id)]
        return comps.url!
    }
}
