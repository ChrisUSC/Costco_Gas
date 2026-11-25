import CostcoGasKit
import SwiftUI

/// "▼ 4¢" in green, "▲ 6¢" in red, "–" when unchanged; VoiceOver hears the direction.
struct TrendLabel: View {
    let trend: Trend?
    let baseline: String

    var body: some View {
        if let trend {
            Text(trend.text)
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(trend.color)
                .accessibilityLabel(trend.accessibilityText(since: baseline))
        }
    }
}

/// "Open · closes 10 PM" with a coloured dot, in the station's own time zone.
struct GasStatusLabel: View {
    let station: Station
    let now: Date

    var body: some View {
        if let status = GasHours.status(hours: station.gasHours, timeZone: station.timeZone, now: now) {
            HStack(spacing: 5) {
                Circle().fill(status.kind.color).frame(width: 7, height: 7).accessibilityHidden(true)
                Text(status.text).foregroundStyle(status.kind == .closed ? Color.red : Color.secondary)
            }
            .font(.caption)
        }
    }
}

/// The "Updated 5 min ago" line: amber when the prices may be out of date, and saying so
/// when they're the saved copy.
struct UpdatedLabel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let label = model.updatedLabel
        Group {
            switch model.loadState {
            case .loading:
                Text("Fetching latest prices…")
            case .failed:
                Text("Couldn't load prices")
            case .ready:
                if model.offline {
                    Label("Offline · prices from \(label.age)", systemImage: "wifi.slash")
                } else if label.stale {
                    Label(label.text, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                } else {
                    Text(label.text)
                }
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityHint(label.detail)
    }
}

struct EmptyStateView: View {
    let systemImage: String
    let title: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        } actions: {
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(.borderedProminent)
            }
        }
    }
}

/// The list header line: "Cheapest Regular within 10 mi".
struct ListHeader: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(nil)
    }
}

/// Grey placeholder rows while the prices load.
struct SkeletonRows: View {
    var body: some View {
        ForEach(0..<5, id: \.self) { _ in
            VStack(alignment: .leading, spacing: 6) {
                Text("Station name, ST").font(.headline)
                Text("1234 Example Street, City").font(.subheadline)
                Text("Open · closes 10 PM").font(.caption)
            }
            .redacted(reason: .placeholder)
            .accessibilityHidden(true)
        }
    }
}

/// A short message at the bottom of the screen that fades after a moment.
struct ToastView: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .shadow(radius: 4, y: 2)
            .padding(.bottom, 24)
            .padding(.horizontal, 16)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityAddTraits(.updatesFrequently)
    }
}
