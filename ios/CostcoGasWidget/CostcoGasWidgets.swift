import CostcoGasKit
import SwiftUI
import WidgetKit

@main
struct CostcoGasWidgets: WidgetBundle {
    var body: some Widget {
        NearbyWidget()
        StationWidget()
    }
}

/// Prices update hourly; check again in half an hour.
private func nextRefresh() -> Date { Date().addingTimeInterval(30 * 60) }

// MARK: - Cheapest nearby

struct NearbyEntry: TimelineEntry {
    let date: Date
    let grade: Grade
    let items: [StationDistance]
    let timestamp: String?
    /// Shown instead of prices: no location, or no data.
    let message: String?
}

struct NearbyProvider: AppIntentTimelineProvider {
    static let radiusMiles = 25.0

    func placeholder(in context: Context) -> NearbyEntry {
        let sample = Station(state: "CA", city: "Turlock", prices: GradePrices(regular: 4.19, premium: 4.59))
        return NearbyEntry(date: Date(), grade: .regular, items: [StationDistance(station: sample, distance: 2.4)],
                           timestamp: nil, message: nil)
    }

    func snapshot(for configuration: NearbyWidgetIntent, in context: Context) async -> NearbyEntry {
        context.isPreview ? placeholder(in: context) : await entry(for: configuration)
    }

    func timeline(for configuration: NearbyWidgetIntent, in context: Context) async -> Timeline<NearbyEntry> {
        Timeline(entries: [await entry(for: configuration)], policy: .after(nextRefresh()))
    }

    private func entry(for configuration: NearbyWidgetIntent) async -> NearbyEntry {
        let grade = configuration.grade.grade
        async let pricesFetch = WidgetData.prices()
        let here = await WidgetLocation().current()
        guard let prices = await pricesFetch else {
            return NearbyEntry(date: Date(), grade: grade, items: [], timestamp: nil, message: "Prices unavailable right now.")
        }
        guard let here else {
            return NearbyEntry(date: Date(), grade: grade, items: [], timestamp: prices.timestamp,
                               message: "Open Costco Gas and allow location to see prices near you.")
        }
        let within = StationQueries.within(prices.stations, of: here, radiusMiles: Self.radiusMiles)
        let sorted = StationQueries.sortNearby(within, grade: grade, by: .price)
        return NearbyEntry(date: Date(), grade: grade, items: Array(sorted.prefix(3)), timestamp: prices.timestamp,
                           message: sorted.isEmpty ? "No Costco \(grade.label.lowercased()) within \(Int(Self.radiusMiles)) miles." : nil)
    }
}

struct NearbyWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "NearbyWidget", intent: NearbyWidgetIntent.self, provider: NearbyProvider()) { entry in
            NearbyWidgetView(entry: entry)
                .containerBackground(.background, for: .widget)
        }
        .configurationDisplayName("Cheapest nearby")
        .description("The cheapest Costco gas near you.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct NearbyWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: NearbyEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Cheapest \(entry.grade.label)", systemImage: "fuelpump.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.costcoBlue)
                .lineLimit(1)
            if let message = entry.message {
                Spacer(minLength: 0)
                Text(message).font(.footnote).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else if family == .systemSmall, let top = entry.items.first {
                Spacer(minLength: 0)
                Text(formatPrice(top.station.price(entry.grade)))
                    .font(.system(size: 30, weight: .bold).monospacedDigit())
                    .foregroundStyle(entry.grade.widgetColor)
                    .minimumScaleFactor(0.7)
                Text(top.station.city).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text("\(String(format: "%.1f", top.distance)) mi away").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else {
                Spacer(minLength: 2)
                ForEach(entry.items) { item in
                    Link(destination: stationURL(item.station)) {
                        HStack {
                            VStack(alignment: .leading, spacing: 0) {
                                Text(item.station.city).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text("\(String(format: "%.1f", item.distance)) mi").font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(formatPrice(item.station.price(entry.grade)))
                                .font(.title3.weight(.bold).monospacedDigit())
                                .foregroundStyle(entry.grade.widgetColor)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            if entry.timestamp != nil {
                Text("Updated \(WidgetData.updatedText(entry.timestamp, now: entry.date))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(entry.items.first.map { stationURL($0.station) })
    }
}

// MARK: - One station

struct StationEntry: TimelineEntry {
    let date: Date
    let grade: Grade
    let station: Station?
    let timestamp: String?
    let message: String?
}

struct StationProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> StationEntry {
        StationEntry(date: Date(), grade: .regular,
                     station: Station(state: "CA", city: "Turlock", prices: GradePrices(regular: 4.19, premium: 4.59),
                                      previous: GradePrices(regular: 4.23, premium: 4.63)),
                     timestamp: nil, message: nil)
    }

    func snapshot(for configuration: StationWidgetIntent, in context: Context) async -> StationEntry {
        context.isPreview ? placeholder(in: context) : await entry(for: configuration)
    }

    func timeline(for configuration: StationWidgetIntent, in context: Context) async -> Timeline<StationEntry> {
        Timeline(entries: [await entry(for: configuration)], policy: .after(nextRefresh()))
    }

    private func entry(for configuration: StationWidgetIntent) async -> StationEntry {
        let grade = configuration.grade.grade
        guard let chosen = configuration.station else {
            return StationEntry(date: Date(), grade: grade, station: nil, timestamp: nil,
                                message: "Touch and hold, then Edit Widget to pick a station.")
        }
        guard let prices = await WidgetData.prices() else {
            return StationEntry(date: Date(), grade: grade, station: nil, timestamp: nil, message: "Prices unavailable right now.")
        }
        guard let station = prices.stations.first(where: { $0.id == chosen.id }) else {
            return StationEntry(date: Date(), grade: grade, station: nil, timestamp: prices.timestamp,
                                message: "No prices for \(chosen.name) right now.")
        }
        return StationEntry(date: Date(), grade: grade, station: station, timestamp: prices.timestamp, message: nil)
    }
}

struct StationWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "StationWidget", intent: StationWidgetIntent.self, provider: StationProvider()) { entry in
            StationWidgetView(entry: entry)
                .containerBackground(.background, for: .widget)
        }
        .configurationDisplayName("Station")
        .description("One Costco station's prices.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct StationWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StationEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let station = entry.station {
                Text(station.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 0)
                if family == .systemSmall {
                    gradePrice(station, entry.grade, large: true)
                } else {
                    HStack(alignment: .bottom, spacing: 16) {
                        ForEach(station.visibleGrades) { grade in
                            gradePrice(station, grade, large: grade == entry.grade)
                        }
                    }
                }
                Spacer(minLength: 0)
                Text("Updated \(WidgetData.updatedText(entry.timestamp, now: entry.date))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                Label("Costco Gas", systemImage: "fuelpump.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.costcoBlue)
                Spacer(minLength: 0)
                Text(entry.message ?? "").font(.footnote).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(entry.station.map(stationURL))
    }

    @ViewBuilder
    private func gradePrice(_ station: Station, _ grade: Grade, large: Bool) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(grade.label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(formatPrice(station.price(grade)))
                .font(large ? .system(size: 28, weight: .bold).monospacedDigit() : .headline.monospacedDigit())
                .foregroundStyle(grade.widgetColor)
                .minimumScaleFactor(0.7)
            if let trend = station.trend(grade) {
                Text(trend.text)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(trend == .flat ? Color.secondary : (trend.text.hasPrefix("▼") ? Color.green : Color.red))
            }
        }
    }
}
