import CostcoGasKit
import SwiftUI

// The station lists behind the tabs (public/js/lists.js): Nearby, State lowest, All stations
// and Favorites.

struct NearbyListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var prefs = model.prefs
        if let center = model.nearbyCenter {
            let within = StationQueries.within(model.stations, of: center, radiusMiles: prefs.nearbyRadius)
            let sorted = StationQueries.sortNearby(within, grade: model.grade, by: prefs.nearbySort)
            let radius = Int(prefs.nearbyRadius)
            List {
                Section {
                    Picker("Radius", selection: $prefs.nearbyRadius) {
                        ForEach(StationQueries.nearbyRadii, id: \.self) { Text("\(Int($0)) mi").tag($0) }
                    }
                    Picker("Sort by", selection: $prefs.nearbySort) {
                        ForEach(NearbySort.allCases) { Text($0.label).tag($0) }
                    }
                }
                Section {
                    if within.isEmpty {
                        Text("No Costco locations found within \(radius) miles.").foregroundStyle(.secondary)
                    } else if sorted.isEmpty {
                        Text("No stations within \(radius) miles have a \(model.grade.label.lowercased()) price right now.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(sorted.enumerated()), id: \.element.id) { index, item in
                            StationRow(station: item.station, rank: prefs.nearbySort == .price ? index + 1 : nil, distance: item.distance)
                        }
                    }
                } header: {
                    ListHeader(text: prefs.nearbySort == .distance
                        ? "Closest stations · \(model.grade.label), within \(radius) mi"
                        : "Cheapest \(model.grade.label) within \(radius) mi")
                }
            }
            .listStyle(.insetGrouped)
        } else {
            EmptyStateView(
                systemImage: "location.circle",
                title: "Find gas near you",
                message: "Share your location, or search for a city or zip code, to see the cheapest Costco gas nearby.",
                actionTitle: "Use my location",
                action: { Task { await model.findMe() } }
            )
        }
    }
}

struct LowestListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        let states = StationQueries.states(model.stations)
        let current = states.contains { $0.code == model.stateContext } ? model.stateContext : (states.first?.code ?? model.stateContext)
        let ranked = StationQueries.lowest(model.stations, state: current, grade: model.grade)
        List {
            Section {
                Picker("State", selection: $model.stateContext) {
                    ForEach(states) { s in
                        Text("\(s.code) · \(s.count) station\(s.count == 1 ? "" : "s")").tag(s.code)
                    }
                }
            }
            Section {
                if ranked.isEmpty {
                    Text("No pricing data found for this state.").foregroundStyle(.secondary)
                } else {
                    ForEach(Array(ranked.enumerated()), id: \.element.id) { index, station in
                        StationRow(station: station, rank: index + 1)
                    }
                }
            } header: {
                ListHeader(text: "Cheapest \(model.grade.label) in \(current)")
            } footer: {
                Text("Arrows show the change since \(model.trendBaselineLabel).")
            }
        }
        .listStyle(.insetGrouped)
    }
}

struct AllStationsView: View {
    @Environment(AppModel.self) private var model
    @State private var filter = ""

    var body: some View {
        let list = StationQueries.search(StationQueries.forGrade(model.stations, model.grade), query: filter, near: model.mapCenter)
        List {
            Section {
                TextField("Filter by city, address or state", text: $filter)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Section {
                if list.isEmpty {
                    Text("No stores found.").foregroundStyle(.secondary)
                } else {
                    ForEach(list) { StationRow(station: $0) }
                }
            } header: {
                ListHeader(text: "\(list.count) station\(list.count == 1 ? "" : "s") · nearest to map centre first")
            }
        }
        .listStyle(.insetGrouped)
    }
}

struct FavoritesView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let favorites = StationQueries.favorites(model.stations, keys: model.prefs.favoriteStations)
        let showRoutes = !model.prefs.favoriteRoutes.isEmpty && !model.offline // routes need a connection
        if favorites.isEmpty && !showRoutes {
            EmptyStateView(systemImage: "star", title: "No favorites yet",
                           message: "Tap the star on any station to save it here, or save a route from the Route tab.")
        } else {
            List {
                if !favorites.isEmpty {
                    Section {
                        ForEach(favorites) { StationRow(station: $0) }
                    } header: {
                        ListHeader(text: "Favorite stations (\(favorites.count))")
                    }
                }
                if showRoutes {
                    SavedRoutesSection()
                }
            }
            .listStyle(.insetGrouped)
        }
    }
}
