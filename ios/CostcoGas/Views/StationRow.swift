import CostcoGasKit
import SwiftUI

/// A station in a list: the selected grade's price is the hero, the other grades sit quietly
/// beneath (the website's store card).
struct StationRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    let station: Station
    var rank: Int?
    var distance: Double?
    var distanceSuffix = ""
    /// On Route results: the fill-up plus detour, against the best value.
    var routeCost: RouteStopCost?

    var body: some View {
        let grade = model.grade
        let isFavorite = model.prefs.isFavorite(station)
        Button {
            model.show(station)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                if let rank {
                    Text("\(rank)")
                        .font(.caption.weight(.bold).monospacedDigit())
                        .frame(width: 24, height: 24)
                        .background(rank == 1 ? Color.costcoBlue : Color.secondary.opacity(0.18), in: Circle())
                        .foregroundStyle(rank == 1 ? Color.white : Color.primary)
                        .accessibilityLabel("Number \(rank)")
                }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        Text(station.name).font(.headline)
                        if isFavorite {
                            Image(systemName: "star.fill").font(.caption).foregroundStyle(.yellow)
                                .accessibilityLabel("Favorite")
                        }
                    }
                    Text(station.displayAddress)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    HStack(spacing: 8) {
                        if let distance {
                            Text("\(String(format: "%.1f", distance)) mi\(distanceSuffix)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        GasStatusLabel(station: station, now: model.now)
                    }
                    let others = station.visibleGrades.filter { $0 != grade }
                    if !others.isEmpty {
                        Text(others.map { "\($0.label) \(formatPrice(station.price($0)))" }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let cost = routeCost {
                        RouteCostLine(cost: cost)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(formatPrice(station.price(grade)))
                        .font(.title3.weight(.bold).monospacedDigit())
                        .foregroundStyle(station.hasPrice(grade) ? grade.color : Color.secondary)
                    Text(grade.label).font(.caption2).foregroundStyle(.secondary)
                    TrendLabel(trend: station.trend(grade), baseline: model.trendBaselineLabel)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shows the station details and moves the map to it")
        .swipeActions(edge: .trailing) {
            Button {
                model.toggleFavorite(station)
            } label: {
                Label(isFavorite ? "Unfavorite" : "Favorite", systemImage: isFavorite ? "star.slash" : "star")
            }
            .tint(.yellow)
            Button {
                openURL(directionsURL(for: station, app: model.prefs.directionsApp))
            } label: {
                Label("Directions", systemImage: "arrow.triangle.turn.up.right.diamond")
            }
            .tint(.costcoBlue)
        }
        .contextMenu {
            Button {
                openURL(directionsURL(for: station, app: model.prefs.directionsApp))
            } label: {
                Label("Directions in \(model.prefs.directionsApp.label)", systemImage: "arrow.triangle.turn.up.right.diamond")
            }
            Button {
                model.toggleFavorite(station)
            } label: {
                Label(isFavorite ? "Remove from favorites" : "Add to favorites", systemImage: isFavorite ? "star.slash" : "star")
            }
            Button {
                model.historyStation = station
            } label: {
                Label("Price history", systemImage: "chart.xyaxis.line")
            }
            ShareLink(item: DeepLink.shareURL(for: station), subject: Text("Costco Gas — \(station.name)")) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        }
    }
}

/// "Fill-up $59.88 + detour $0.40 · Best value" (or "+$0.85 vs best") on a Route result. One
/// sentence that wraps onto a second line when it doesn't fit, so no amount is ever cut off.
struct RouteCostLine: View {
    let cost: RouteStopCost

    var body: some View {
        let detour = cost.detourCost >= 0.005 ? " + detour \(formatPrice(cost.detourCost))" : " · no detour"
        let verdict = cost.isBest
            ? Text("Best value").fontWeight(.semibold).foregroundStyle(.green)
            : Text("+\(formatPrice(cost.extraVsBest)) vs best").fontWeight(.semibold).foregroundStyle(.primary)
        (Text("Fill-up \(formatPrice(cost.fillCost))\(detour) · ").foregroundStyle(.secondary) + verdict)
            .font(.caption.monospacedDigit())
            .fixedSize(horizontal: false, vertical: true)
    }
}
