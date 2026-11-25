import CostcoGasKit
import SwiftUI

/// The station details card: every grade's price and trend, open status, gas hours,
/// directions, phone, price history, favorite and share.
struct StationDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let station: Station

    var body: some View {
        // Fresh prices replace the copy this screen was opened with.
        let s = model.station(withID: station.id) ?? station
        let isFavorite = model.prefs.isFavorite(s)
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(s.displayAddress).font(.subheadline).foregroundStyle(.secondary)
                    GasStatusLabel(station: s, now: model.now)
                }
                .padding(.vertical, 2)
            }

            Section {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 10)], spacing: 10) {
                    ForEach(s.visibleGrades) { grade in
                        PriceTile(station: s, grade: grade, highlighted: grade == model.grade, baseline: model.trendBaselineLabel)
                    }
                }
                .padding(.vertical, 4)
            } header: {
                HStack {
                    ListHeader(text: "Prices")
                    Spacer()
                    if model.liveQuotes[s.id] != nil {
                        Label("Live from Costco", systemImage: "dot.radiowaves.left.and.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.green)
                            .textCase(nil)
                    }
                }
            } footer: {
                LivePriceFooter(station: s)
            }

            if let cost = model.fillCost(for: s) {
                FillUpSection(cost: cost)
            }

            Section {
                Button {
                    openURL(directionsURL(for: s, app: model.prefs.directionsApp))
                } label: {
                    Label("Directions in \(model.prefs.directionsApp.label)", systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                }
                if let phone = s.phone, let url = s.phoneURL {
                    Link(destination: url) { Label(phone, systemImage: "phone.fill") }
                }
                Button {
                    model.historyStation = s
                } label: {
                    Label("Price history", systemImage: "chart.xyaxis.line")
                }
                Button {
                    model.toggleFavorite(s)
                } label: {
                    Label(isFavorite ? "Remove from favorites" : "Add to favorites", systemImage: isFavorite ? "star.fill" : "star")
                }
                ShareLink(item: DeepLink.shareURL(for: s), subject: Text("Costco Gas — \(s.name)")) {
                    Label("Share this station", systemImage: "square.and.arrow.up")
                }
                if let page = s.url.flatMap(URL.init(string:)) {
                    Link(destination: page) { Label("Warehouse page on costco.com", systemImage: "safari") }
                }
            }

            if let hours = s.gasHours, !hours.isEmpty {
                Section {
                    ForEach(GasHours.grouped(hours), id: \.self) { row in
                        LabeledContent(row.label, value: row.text)
                    }
                } header: {
                    ListHeader(text: "Gas hours")
                }
            }
        }
        .listStyle(.insetGrouped)
        // Ask Costco for this store's current price as soon as it's opened.
        .task(id: station.id) { await model.fetchLivePrice(for: s) }
        .navigationTitle(s.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar) // the panel's main screen hides it
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    model.toggleFavorite(s)
                } label: {
                    Image(systemName: isFavorite ? "star.fill" : "star")
                }
                .tint(.yellow)
                .accessibilityLabel(isFavorite ? "Remove from favorites" : "Add to favorites")
            }
        }
    }
}

/// Says where the prices came from: a live reading from Costco (and what it changed), a
/// reading in progress, or the hourly prices when Costco couldn't be reached.
private struct LivePriceFooter: View {
    @Environment(AppModel.self) private var model
    let station: Station

    var body: some View {
        let trendNote = "Arrows show the change since \(model.trendBaselineLabel)."
        VStack(alignment: .leading, spacing: 6) {
            if let quote = model.liveQuotes[station.id] {
                Text("Checked with Costco \(age(quote.fetchedAt)). \(trendNote)")
                let changes = station.visibleGrades.compactMap { grade -> String? in
                    let was = quote.hourly[grade]
                    guard quote.prices[grade] != was else { return nil }
                    return "\(grade.label) was \(formatPrice(was))"
                }
                if !changes.isEmpty {
                    Text("Changed since the hourly update: \(changes.joined(separator: ", ")).")
                        .foregroundStyle(.orange)
                }
            } else if model.liveFetch[station.id] == .loading {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Checking Costco for the current price…")
                }
            } else if model.liveFetch[station.id] == .failed {
                Text("Couldn't reach Costco for a live price, so these are the hourly prices (\(model.updatedLabel.age)). \(trendNote)")
                Button("Try again") { Task { await model.fetchLivePrice(for: station) } }
                    .font(.footnote.weight(.semibold))
            } else {
                Text("\(model.updatedLabel.text). \(trendNote)")
            }
        }
    }

    private func age(_ date: Date) -> String {
        let minutes = Int(max(0, model.now.timeIntervalSince(date)) / 60)
        return minutes < 1 ? "just now" : "\(minutes) min ago"
    }
}

/// What your usual fill-up costs here.
private struct FillUpSection: View {
    @Environment(AppModel.self) private var model
    let cost: Double

    var body: some View {
        Section {
            LabeledContent("Fill-up · \(formatNumber(model.prefs.fillGallons)) gal \(model.grade.label)",
                           value: formatPrice(cost))
        } header: {
            ListHeader(text: "Fill-up cost")
        } footer: {
            Button("\(formatNumber(model.prefs.fillGallons)) gal · \(formatNumber(model.prefs.mpg)) mpg · Change") {
                model.showSettings = true
            }
            .font(.footnote)
        }
    }
}

private struct PriceTile: View {
    let station: Station
    let grade: Grade
    let highlighted: Bool
    let baseline: String

    var body: some View {
        VStack(spacing: 4) {
            Text(grade.label).font(.caption.weight(.semibold)).foregroundStyle(.primary)
            Text(formatPrice(station.price(grade)))
                .font(.title2.weight(.bold).monospacedDigit())
                .foregroundStyle(grade.color)
            TrendLabel(trend: station.trend(grade), baseline: baseline)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(uiColor: highlighted ? .tertiarySystemGroupedBackground : .systemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(highlighted ? grade.color : Color(uiColor: .separator), lineWidth: highlighted ? 2 : 1)
        )
        .accessibilityElement(children: .combine)
    }
}
