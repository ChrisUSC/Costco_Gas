import CostcoGasKit
import SwiftUI

/// The map with the panel: a sidebar on iPad and wide screens, a bottom sheet on iPhone
/// (the website's tablet/desktop sidebar and phone bottom sheet).
struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(QuickActions.self) private var quickActions
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase

    private static let peek = PresentationDetent.height(190)
    private static let half = PresentationDetent.fraction(0.5)
    @State private var detent: PresentationDetent = ContentView.half

    var body: some View {
        GeometryReader { geometry in
            if horizontalSizeClass == .regular {
                HStack(spacing: 0) {
                    PanelView()
                        .frame(width: min(420, geometry.size.width * 0.42))
                    Divider()
                    MapLayer(bottomInset: 0)
                }
            } else {
                MapLayer(bottomInset: geometry.size.height * 0.5)
                    .sheet(isPresented: .constant(true)) {
                        PanelView()
                            .presentationDetents([ContentView.peek, ContentView.half, .large], selection: $detent)
                            .presentationBackgroundInteraction(.enabled(upThrough: ContentView.half))
                            .presentationDragIndicator(.visible)
                            // Solid, not see-through glass: text over the map was hard to read.
                            .presentationBackground(Color.panelBackground)
                            .interactiveDismissDisabled()
                    }
            }
        }
        .preferredColorScheme(model.prefs.theme.colorScheme)
        .task { await model.start() }
        .task {
            // Keep "Updated … ago" and open / closed labels current.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                model.now = Date()
            }
        }
        .task(id: model.offline) {
            // Offline: try for fresh prices every 30 seconds until they arrive.
            while model.offline && !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                if Task.isCancelled { break }
                await model.refresh()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refreshIfStale() } }
        }
        .onChange(of: model.selectedStation) { _, station in
            if station != nil && detent == ContentView.peek { detent = ContentView.half }
        }
        .onChange(of: quickActions.pendingTab, initial: true) { _, tab in
            guard let tab else { return }
            model.openTab(tab)
            quickActions.pendingTab = nil
        }
        .onOpenURL { url in
            if let link = DeepLink(url: url) { model.handle(link) }
        }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL, let link = DeepLink(url: url) { model.handle(link) }
        }
    }
}

private struct MapLayer: View {
    @Environment(AppModel.self) private var model
    let bottomInset: CGFloat

    var body: some View {
        StationMapView(
            stations: model.mapStations,
            grade: model.grade,
            clustering: model.prefs.clusterMarkers,
            colorPins: model.prefs.colorPins,
            route: model.currentTab == .route ? model.routeResult : nil,
            searchedPlace: model.searchedPlace,
            showsUserLocation: model.deviceLocation != nil,
            request: model.mapRequest,
            bottomInset: bottomInset,
            onSelect: { model.show($0) },
            onRegionChange: { center, span, scale in
                model.mapCenter = center
                model.mapSpanDegrees = span
                model.legend = scale
            }
        )
        .ignoresSafeArea()
        .overlay(alignment: .top) {
            VStack(spacing: 8) {
                if model.showSearchThisArea {
                    Button {
                        model.searchMapArea()
                    } label: {
                        Label("Search this area", systemImage: "magnifyingglass")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(Color(uiColor: .systemBackground), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .shadow(radius: 3, y: 1)
                }
                if model.prefs.colorPins, let legend = model.legend {
                    PriceLegend(scale: legend, grade: model.grade)
                }
            }
            .padding(.top, 8)
        }
    }
}

/// The price-colour key: "Regular in view  $3.89 ▬▬▬ $4.29".
private struct PriceLegend: View {
    let scale: PriceTierScale
    let grade: Grade

    var body: some View {
        HStack(spacing: 6) {
            Text(scale.comparable ? "\(grade.label) in view" : "\(grade.label) prices")
                .font(.caption.weight(.semibold))
            if scale.comparable {
                Text(formatPrice(scale.min)).font(.caption.monospacedDigit())
                LinearGradient(colors: [.green, .orange, .red], startPoint: .leading, endPoint: .trailing)
                    .frame(width: 60, height: 6)
                    .clipShape(Capsule())
                    .accessibilityHidden(true)
                Text(formatPrice(scale.max)).font(.caption.monospacedDigit())
            } else {
                Text("too close to colour").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(uiColor: .systemBackground), in: Capsule())
        .accessibilityElement(children: .combine)
    }
}
