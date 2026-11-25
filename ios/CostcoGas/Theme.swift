import CoreLocation
import CostcoGasKit
import SwiftUI
import UIKit

// Colours and the tab list, shared by every screen. The grade colours are the website's hues
// (public/js/prices.js GRADE_INFO), shaded per light / dark mode for contrast.

extension Color {
    static let costcoBlue = Color(red: 0, green: 0x5D / 255, blue: 0xAA / 255)
    static let costcoRed = Color(red: 0xE3 / 255, green: 0x18 / 255, blue: 0x37 / 255)
}

extension Color {
    /// A colour with separate light- and dark-mode values.
    init(light: UIColor, dark: UIColor) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }

    /// The solid background behind the panel, so the map never shows through text.
    static let panelBackground = Color(uiColor: .systemGroupedBackground)
}

private func rgb(_ hex: UInt32) -> UIColor {
    UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

extension Grade {
    /// Darker shades in light mode and lighter ones in dark mode, so each grade's price meets
    /// WCAG AA contrast (4.5:1 or more) on the panel's rows in both.
    var color: Color {
        switch self {
        case .regular: return Color(light: rgb(0x047857), dark: rgb(0x34D399))
        case .premium: return Color(light: rgb(0x1D4ED8), dark: rgb(0x7DB4FF))
        case .diesel: return Color(light: rgb(0xB45309), dark: rgb(0xFBBF24))
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

    /// Fits under the icon in the panel's tab bar.
    var shortTitle: String { self == .search ? "All" : title }

    var selectedSystemImage: String {
        switch self {
        case .nearby: return "location.fill"
        case .lowest: return "trophy.fill"
        case .route: return "point.topleft.down.to.point.bottomright.curvepath.fill"
        case .search: return "list.bullet"
        case .favorites: return "star.fill"
        }
    }
}

/// How far the iPhone bottom sheet is pulled up.
enum PanelSize {
    case collapsed, half, full
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
