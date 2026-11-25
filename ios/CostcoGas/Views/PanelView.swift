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
        VStack(spacing: 12) {
            Picker("Fuel grade", selection: Binding(get: { model.grade }, set: { model.setGrade($0) })) {
                ForEach(Grade.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .controlSize(.large)

            TabBar()

            HStack(spacing: 8) {
                UpdatedLabel()
                Spacer(minLength: 8)
                if model.loadState == .ready {
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                            .labelStyle(.iconOnly)
                            .font(.footnote.weight(.semibold))
                            .frame(width: 32, height: 28)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .accessibilityLabel("Refresh prices")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 12)
    }
}

/// Every visible tab fits across the panel, icon above a short label: no scrolling, nothing
/// cut off at the edge.
private struct TabBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 4) {
            ForEach(model.visibleTabs) { tab in
                let selected = tab == model.currentTab
                Button {
                    model.currentTab = tab
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: selected ? tab.selectedSystemImage : tab.systemImage)
                            .font(.system(size: 17, weight: .semibold))
                            .frame(height: 20)
                        Text(tab.shortTitle)
                            .font(.caption2.weight(selected ? .bold : .medium))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .foregroundStyle(selected ? Color.costcoBlue : Color.secondary)
                    .background(
                        RoundedRectangle(cornerRadius: 10)
                            .fill(selected ? Color.costcoBlue.opacity(0.14) : Color.clear)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
                .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(4)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
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
