import CoreLocation
import CostcoGasKit
import SwiftUI

// Colours and the tab list, shared by every screen. The grade colours match the website's
// chart (public/js/prices.js GRADE_INFO).

extension Color {
    static let costcoBlue = Color(red: 0, green: 0x5D / 255, blue: 0xAA / 255)
    static let costcoRed = Color(red: 0xE3 / 255, green: 0x18 / 255, blue: 0x37 / 255)
}

extension Grade {
    var color: Color {
        switch self {
        case .regular: return Color(red: 0x0F / 255, green: 0x9D / 255, blue: 0x6B / 255)
        case .premium: return Color(red: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255)
        case .diesel: return Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x06 / 255)
        }
    }
}

extension GasStatus.Kind {
    var color: Color {
        switch self {
        case .open: return .green
        case .closingSoon: return .orange
        case .closed: return .red
        }
    }
}

extension Trend {
    /// Down is good news for drivers.
    var color: Color {
        switch self {
        case .flat: return .secondary
        case .up: return .red
        case .down: return .green
        }
    }
}

enum AppTab: String, CaseIterable, Identifiable, Codable {
    case nearby, lowest, route, search, favorites

    var id: String { rawValue }

    var title: String {
        switch self {
        case .nearby: return "Nearby"
        case .lowest: return "Lowest"
        case .route: return "Route"
        case .search: return "All stations"
        case .favorites: return "Favorites"
        }
    }

    var systemImage: String {
        switch self {
        case .nearby: return "location"
        case .lowest: return "trophy"
        case .route: return "point.topleft.down.to.point.bottomright.curvepath"
        case .search: return "list.bullet"
        case .favorites: return "star"
        }
    }
}

enum ThemePreference: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

/// The grade the app opens on: a fixed grade, or whichever was picked last time.
enum DefaultGrade: String, CaseIterable, Identifiable {
    case last, regular, premium, diesel

    var id: String { rawValue }
    var label: String { self == .last ? "Last used" : (Grade(rawValue: rawValue)?.label ?? rawValue) }
}

extension LatLng {
    init(_ coordinate: CLLocationCoordinate2D) {
        self.init(coordinate.latitude, coordinate.longitude)
    }

    var clCoordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}
