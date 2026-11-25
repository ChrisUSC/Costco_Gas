import CostcoGasKit
import SwiftUI

/// Route tab (public/js/routes.js): the cheapest stations within a set distance of a driving
/// route, with saved routes.
struct RouteView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List {
            Section {
                PlaceField(title: "From", text: $model.routeOriginText, place: $model.routeOrigin) {
                    Button {
                        Task { await model.useMyLocationForRoute() }
                    } label: {
                        Image(systemName: "location.fill")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Use my location")
                }
                PlaceField(title: "To", text: $model.routeDestText, place: $model.routeDest) { EmptyView() }
                Stepper(value: $model.routeBuffer, in: 1...25, step: 1) {
                    Text("Detour limit: \(Int(model.routeBuffer)) mi from the route")
                }
                Button {
                    Task { await model.findRoute() }
                } label: {
                    HStack {
                        Label("Find cheapest along route", systemImage: "fuelpump")
                        if model.routeBusy { Spacer(); ProgressView() }
                    }
                }
                .disabled(model.routeBusy)

                if model.editingRouteID != nil {
                    if model.routeResult != nil {
                        Button { model.saveRoute() } label: { Label("Update route", systemImage: "square.and.arrow.down") }
                    }
                    Button("Cancel editing", role: .cancel) { model.cancelEditRoute() }
                } else if model.routeResult != nil {
                    Button { model.saveRoute() } label: { Label("Save this route", systemImage: "star") }
                }
            } footer: {
                if let error = model.routeError {
                    Text(error).foregroundStyle(.red)
                }
            }

            if !model.prefs.favoriteRoutes.isEmpty {
                SavedRoutesSection()
            }

            if let result = model.routeResult {
                RouteResultsSection(result: result)
            }
        }
        .listStyle(.insetGrouped)
        .task { await model.prefillRouteOrigin() }
    }
}

private struct RouteResultsSection: View {
    @Environment(AppModel.self) private var model
    let result: RouteResult

    var body: some View {
        @Bindable var prefs = model.prefs
        // Best value: your usual fill-up plus the detour off the route (FillUp in the Kit).
        let stops = model.routeStops(result)
        Section {
            if result.route.isApproximate {
                Label("Live routing was unavailable, so this is an approximate straight-line path, not a real driving route.",
                      systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            Button { model.showRouteOnMap() } label: { Label("View route on map", systemImage: "map") }
            if stops.isEmpty {
                Text("No Costco gas stations found within \(Int(result.bufferMiles)) miles of this route.")
                    .foregroundStyle(.secondary)
            } else {
                Picker("Sort by", selection: $prefs.routeSort) {
                    ForEach(RouteSort.allCases) { Text($0.label).tag($0) }
                }
                ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                    StationRow(station: stop.station, rank: index + 1, distance: stop.offRoute,
                               distanceSuffix: " off route", routeCost: stop)
                }
            }
        } header: {
            VStack(alignment: .leading, spacing: 2) {
                ListHeader(text: "\(Int(result.route.distanceMiles.rounded())) mi route · \(stops.count) station\(stops.count == 1 ? "" : "s") found")
                if !stops.isEmpty {
                    ListHeader(text: prefs.routeSort == .value
                        ? "Best value for \(formatNumber(prefs.fillGallons)) gal \(model.grade.label), detour included"
                        : "Cheapest \(model.grade.label) along the way")
                }
            }
        }
    }
}

/// Saved routes, shown on the Route and Favorites tabs.
struct SavedRoutesSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Section {
            ForEach(model.prefs.favoriteRoutes) { route in
                Button {
                    Task { await model.loadSavedRoute(route.id) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(route.origin.label) → \(route.destination.label)")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                        Text("Within \(Int(route.bufferMiles)) mi of the route\(model.editingRouteID == route.id ? " · editing" : "")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { model.deleteRoute(route.id) } label: { Label("Delete", systemImage: "trash") }
                    Button { Task { await model.editSavedRoute(route.id) } } label: { Label("Edit", systemImage: "pencil") }
                        .tint(.orange)
                }
                .contextMenu {
                    Button { Task { await model.loadSavedRoute(route.id) } } label: { Label("Find stations", systemImage: "fuelpump") }
                    Button { Task { await model.editSavedRoute(route.id) } } label: { Label("Edit", systemImage: "pencil") }
                    Button(role: .destructive) { model.deleteRoute(route.id) } label: { Label("Delete", systemImage: "trash") }
                }
            }
        } header: {
            ListHeader(text: "Saved routes")
        }
    }
}

/// A place text field with suggestions: Costco stations and Nominatim places.
struct PlaceField<Accessory: View>: View {
    @Environment(AppModel.self) private var model
    let title: String
    @Binding var text: String
    @Binding var place: Place?
    @ViewBuilder var accessory: () -> Accessory

    @FocusState private var focused: Bool
    @State private var suggestions: [GeoResult] = []

    var body: some View {
        HStack {
            Text(title).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
            TextField("Address or city", text: $text)
                .focused($focused)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { Task { await model.findRoute() } }
            if !text.isEmpty && focused {
                Button { text = ""; place = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Clear")
            }
            accessory()
        }
        .task(id: focused ? text : "") { await lookUp() }

        if focused {
            ForEach(stationSuggestions) { station in
                Button {
                    choose(Place(station.coordinate ?? LatLng(0, 0), label: "Costco \(station.name)"))
                } label: {
                    Label { Text(station.name) } icon: { Image(systemName: "fuelpump") }
                }
                .disabled(station.coordinate == nil)
            }
            ForEach(suggestions) { result in
                Button { choose(result.place) } label: {
                    Label {
                        VStack(alignment: .leading) {
                            Text(result.place.label)
                            Text(result.kind).font(.caption).foregroundStyle(.secondary)
                        }
                    } icon: { Image(systemName: "mappin") }
                }
            }
        }
    }

    private var stationSuggestions: [Station] {
        let q = text.trimmingCharacters(in: .whitespaces)
        guard q.count >= 1, place?.label != text else { return [] }
        return Array(StationQueries.search(model.stations, query: q, near: model.mapCenter).prefix(3))
    }

    private func choose(_ chosen: Place) {
        place = chosen
        text = chosen.label
        suggestions = []
        focused = false
    }

    private func lookUp() async {
        let q = text.trimmingCharacters(in: .whitespaces)
        guard focused, q.count >= 2, place?.label != text, !model.offline else {
            suggestions = []
            return
        }
        try? await Task.sleep(nanoseconds: 400_000_000) // typing pause
        if Task.isCancelled { return }
        let results = (try? await Geocoder.search(q, viewbox: model.mapViewbox)) ?? []
        if !Task.isCancelled { suggestions = results }
    }
}
