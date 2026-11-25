import CostcoGasKit
import SwiftUI

/// The sidebar (iPad) or bottom sheet (iPhone): search, the grade toggle, the "Updated"
/// line, the tab strip and the active tab. Station details push inside it.
struct PanelView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            VStack(spacing: 0) {
                PanelHeader()
                Divider()
                Group {
                    if !query.isEmpty {
                        SearchResultsView(query: $query)
                    } else {
                        TabContent()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Color.panelBackground)
            .navigationTitle("Costco Gas")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "City, address or zip code")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await model.findMe() }
                    } label: {
                        Image(systemName: "location.fill")
                    }
                    .accessibilityLabel("Near me")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        model.showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .navigationDestination(item: $model.selectedStation) { station in
                StationDetailView(station: station)
            }
        }
        .sheet(isPresented: $model.showSettings) {
            SettingsView().presentationBackground(Color.panelBackground)
        }
        .sheet(item: $model.historyStation) { station in
            PriceHistoryView(station: station).presentationBackground(Color.panelBackground)
        }
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                ToastView(message: toast)
                    .task(id: toast) {
                        try? await Task.sleep(nanoseconds: 2_600_000_000)
                        withAnimation { model.toast = nil }
                    }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.toast)
        .preferredColorScheme(model.prefs.theme.colorScheme)
    }
}

private struct PanelHeader: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Fuel grade", selection: Binding(get: { model.grade }, set: { model.setGrade($0) })) {
                ForEach(Grade.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)

            HStack {
                UpdatedLabel()
                Spacer()
                if model.loadState == .ready {
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise").font(.caption)
                    }
                    .accessibilityLabel("Refresh prices")
                }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.visibleTabs) { tab in
                        let selected = tab == model.currentTab
                        Button {
                            model.currentTab = tab
                        } label: {
                            Label(tab.title, systemImage: tab.systemImage)
                                .font(.subheadline.weight(.medium))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(selected ? Color.costcoBlue : Color.secondary.opacity(0.14), in: Capsule())
                                .foregroundStyle(selected ? Color.white : Color.primary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
    }
}

private struct TabContent: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.loadState {
        case .loading:
            List { SkeletonRows() }.listStyle(.insetGrouped)
        case .failed:
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                title: "Couldn't load gas prices",
                message: "Something went wrong fetching the latest prices. Check your connection and try again.",
                actionTitle: "Try again",
                action: { Task { await model.load() } }
            )
        case .ready:
            switch model.currentTab {
            case .nearby: NearbyListView()
            case .lowest: LowestListView()
            case .route: RouteView()
            case .search: AllStationsView()
            case .favorites: FavoritesView()
            }
        }
    }
}
