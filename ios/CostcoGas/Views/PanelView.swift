import CostcoGasKit
import SwiftUI

/// The sidebar (iPad) or bottom sheet (iPhone): the search row, the grade toggle, the tab bar,
/// the "Updated" line and the active tab. Station details push inside it. Pulled all the way
/// down on iPhone, only the search row shows.
struct PanelView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            VStack(spacing: 0) {
                SearchRow(query: $query, focused: $searchFocused)
                if model.panelSize != .collapsed {
                    if query.isEmpty {
                        PanelHeader()
                    }
                    Divider()
                    Group {
                        if !query.isEmpty {
                            SearchResultsView(query: $query, onDone: {
                                searchFocused = false
                                model.panelSize = .half
                            })
                        } else {
                            TabContent()
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .background(Color.panelBackground)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $model.selectedStation) { station in
                StationDetailView(station: station)
            }
        }
        .onChange(of: searchFocused) { _, focused in
            if focused { model.panelSize = .full }
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

/// The search field with the Near me and Settings buttons beside it (Cancel while typing).
private struct SearchRow: View {
    @Environment(AppModel.self) private var model
    @Binding var query: String
    var focused: FocusState<Bool>.Binding

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                TextField("City, address or zip code", text: $query)
                    .focused(focused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))

            if focused.wrappedValue {
                Button("Cancel") {
                    query = ""
                    focused.wrappedValue = false
                }
                .fontWeight(.medium)
            } else {
                CircleButton(systemImage: "location.fill", label: "Near me") {
                    Task { await model.findMe() }
                }
                CircleButton(systemImage: "gearshape.fill", label: "Settings") {
                    model.showSettings = true
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 10)
        .animation(.easeInOut(duration: 0.15), value: focused.wrappedValue)
    }
}

private struct CircleButton: View {
    let systemImage: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 44, height: 44)
                .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                .foregroundStyle(Color.costcoBlue)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
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

            UpdatedLabel()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.top, 2)
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
