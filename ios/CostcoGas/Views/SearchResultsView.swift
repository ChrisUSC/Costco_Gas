import CostcoGasKit
import SwiftUI

/// Header search (public/js/search.js): matching Costco stations nearest the map centre, then
/// places from Nominatim. Offline, only stations are searched.
struct SearchResultsView: View {
    @Environment(AppModel.self) private var model
    @Binding var query: String
    /// Closes the keyboard once a result is picked.
    var onDone: () -> Void = {}

    @State private var places: [GeoResult] = []
    @State private var searchingPlaces = false

    var body: some View {
        let q = query.lowercased().trimmingCharacters(in: .whitespaces)
        let stations = Array(StationQueries.search(model.stations, query: q, near: model.mapCenter).prefix(5))
        List {
            if !stations.isEmpty {
                Section {
                    ForEach(stations) { station in
                        Button {
                            finish()
                            model.show(station)
                        } label: {
                            Label {
                                VStack(alignment: .leading) {
                                    Text(station.name).foregroundStyle(.primary)
                                    Text(station.displayAddress).font(.caption).foregroundStyle(.secondary)
                                }
                            } icon: {
                                Image(systemName: "fuelpump.fill").foregroundStyle(Color.costcoBlue)
                            }
                        }
                    }
                } header: {
                    ListHeader(text: "Costco stations")
                }
            }
            if !places.isEmpty {
                Section {
                    ForEach(places) { result in
                        Button {
                            finish()
                            model.showPlace(result.place)
                        } label: {
                            Label {
                                VStack(alignment: .leading) {
                                    Text(result.place.label).foregroundStyle(.primary)
                                    Text(result.kind).font(.caption).foregroundStyle(.secondary)
                                }
                            } icon: {
                                Image(systemName: "mappin.circle.fill").foregroundStyle(.indigo)
                            }
                        }
                    }
                } header: {
                    ListHeader(text: "Locations")
                }
            } else if searchingPlaces {
                HStack { ProgressView(); Text("Searching locations…").foregroundStyle(.secondary) }
            }
            if stations.isEmpty && places.isEmpty && !searchingPlaces {
                Text("No matches found").foregroundStyle(.secondary)
            }
        }
        .listStyle(.insetGrouped)
        .task(id: q) { await lookUpPlaces(q) }
    }

    private func finish() {
        query = ""
        onDone()
    }

    private func lookUpPlaces(_ q: String) async {
        guard q.count >= 2, !model.offline else {
            places = []
            searchingPlaces = false
            return
        }
        searchingPlaces = true
        try? await Task.sleep(nanoseconds: 400_000_000) // typing pause
        if Task.isCancelled { return }
        let results = (try? await Geocoder.search(q, viewbox: model.mapViewbox)) ?? []
        if Task.isCancelled { return }
        places = results
        searchingPlaces = false
    }
}
