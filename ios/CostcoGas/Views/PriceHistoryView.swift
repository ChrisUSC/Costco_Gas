import Charts
import CostcoGasKit
import SwiftUI

/// Price-history chart (public/js/charts.js): one point per day, a solid dot where the price
/// changed, 7D / 30D / 90D / 1Y / All ranges, and a readout for the day you touch.
struct PriceHistoryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let station: Station

    @State private var selectedDate: Date?

    var body: some View {
        @Bindable var prefs = model.prefs
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Picker("Range", selection: $prefs.historyRange) {
                    ForEach(HistoryRange.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                content
                Spacer(minLength: 0)
            }
            .padding()
            .navigationTitle("Price history")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text("Price history").font(.headline)
                        Text(station.name).font(.caption).foregroundStyle(.secondary)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await model.loadHistory() }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private var content: some View {
        switch model.historyLoad {
        case .idle, .loading:
            ProgressView("Loading price history…")
                .frame(maxWidth: .infinity, minHeight: 240)
        case .failed:
            ContentUnavailableView {
                Label("Couldn't load price history", systemImage: "exclamationmark.triangle")
            } description: {
                Text(model.offline ? "You appear to be offline. Please try again." : "Something went wrong. Please try again.")
            } actions: {
                Button("Try again") { Task { await model.loadHistory() } }
                    .buttonStyle(.borderedProminent)
            }
        case .ready:
            let series = model.historySeries(for: station)
            if model.history?.points(for: station.id).isEmpty ?? true {
                Text("No price history available for \(station.name).").foregroundStyle(.secondary)
            } else if series.isEmpty {
                Text("No price history available for \(station.name) in this range.").foregroundStyle(.secondary)
            } else {
                HistoryChart(series: series, selectedDate: $selectedDate)
                    .frame(minHeight: 260)
            }
        }
    }
}

private struct HistoryChart: View {
    let series: [DailyPrice]
    @Binding var selectedDate: Date?

    private var grades: [Grade] {
        Grade.allCases.filter { g in g != .diesel || series.contains { $0.prices[g] != nil } }
    }

    private var showAllDots: Bool { series.count <= PriceHistory.showAllDotsMaxPoints }

    private var selected: DailyPrice? {
        guard let selectedDate else { return nil }
        return series.min { abs($0.date.timeIntervalSince(selectedDate)) < abs($1.date.timeIntervalSince(selectedDate)) }
    }

    var body: some View {
        Chart {
            ForEach(grades) { grade in
                marks(for: grade)
            }
            if let selected {
                RuleMark(x: .value("Date", selected.date, unit: .day))
                    .foregroundStyle(Color.secondary.opacity(0.4))
                    .annotation(position: .top, spacing: 4, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        readout(for: selected)
                    }
            }
        }
        .chartForegroundStyleScale(domain: grades.map(\.label), range: grades.map(\.color))
        .chartYScale(domain: .automatic(includesZero: false))
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine()
                AxisValueLabel {
                    if let price = value.as(Double.self) { Text(formatPrice(price)) }
                }
            }
        }
        .chartXSelection(value: $selectedDate)
        .chartLegend(position: .top, alignment: .leading)
        .accessibilityLabel("Price history chart")
    }

    @ChartContentBuilder
    private func marks(for grade: Grade) -> some ChartContent {
        ForEach(series) { day in
            if let price = day.prices[grade] {
                // Holds each price across the day, then steps to the next.
                LineMark(x: .value("Date", day.date, unit: .day), y: .value("Price", price), series: .value("Grade", grade.label))
                    .foregroundStyle(by: .value("Grade", grade.label))
                    .interpolationMethod(.stepEnd)
                if day.changed.contains(grade) || showAllDots {
                    PointMark(x: .value("Date", day.date, unit: .day), y: .value("Price", price))
                        .foregroundStyle(by: .value("Grade", grade.label))
                        .symbolSize(day.changed.contains(grade) ? 36 : 10)
                        .opacity(day.changed.contains(grade) ? 1 : 0.5)
                }
            }
        }
    }

    private func readout(for day: DailyPrice) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(day.date.formatted(date: .abbreviated, time: .omitted)).font(.caption.weight(.semibold))
            ForEach(grades) { grade in
                Text("\(grade.label): \(day.prices[grade].map { formatPrice($0) } ?? "n/a")")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(grade.color)
            }
        }
        .padding(6)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }
}
