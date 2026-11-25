import CostcoGasKit
import SwiftUI

/// Settings panel (public/js/settings.js).
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var prefs = model.prefs
        NavigationStack {
            Form {
                Section {
                    Toggle("Group nearby stations when zoomed out", isOn: $prefs.clusterMarkers)
                    Toggle("Colour pins by price", isOn: $prefs.colorPins)
                } header: {
                    Text("Map")
                } footer: {
                    Text("Price colours show the cheapest, middle and most expensive third of the prices in view in green, amber and red.")
                }

                Section("Directions") {
                    Picker("Open directions in", selection: $prefs.directionsApp) {
                        ForEach(DirectionsApp.allCases) { Text($0.label).tag($0) }
                    }
                }

                Section("Appearance") {
                    Picker("Theme", selection: $prefs.theme) {
                        ForEach(ThemePreference.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }

                Section {
                    ForEach(AppTab.allCases) { tab in
                        let shown = !prefs.hiddenTabs.contains(tab)
                        Toggle(isOn: Binding(get: { shown }, set: { prefs.setTab(tab, visible: $0) })) {
                            Label(tab.title, systemImage: tab.systemImage)
                        }
                        // At least one tab always stays shown.
                        .disabled(shown && prefs.visibleTabs.count == 1)
                    }
                    Picker("Start-up tab", selection: $prefs.defaultTab) {
                        ForEach(prefs.visibleTabs) { Text($0.title).tag($0) }
                    }
                    Picker("Fuel grade on opening", selection: $prefs.defaultGrade) {
                        ForEach(DefaultGrade.allCases) { Text($0.label).tag($0) }
                    }
                } header: {
                    Text("Tabs")
                } footer: {
                    Text("The search field finds stations even when All stations is hidden.")
                }

                Section {
                    Toggle("Use my location automatically", isOn: $prefs.autoLocate)
                } header: {
                    Text("Location")
                } footer: {
                    Text("When on and location access is allowed, the app opens on stations near you and starts routes from where you are. It never asks for access by itself.")
                }

                Section("About") {
                    LabeledContent("Prices", value: model.updatedLabel.text)
                    Link(destination: siteURL) { Label("Open the website", systemImage: "safari") }
                    Text("Prices are collected from costco.com every hour. Routes by OSRM, place search by OpenStreetMap Nominatim.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .preferredColorScheme(model.prefs.theme.colorScheme)
    }
}
