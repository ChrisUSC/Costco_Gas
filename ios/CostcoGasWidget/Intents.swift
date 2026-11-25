import AppIntents
import CostcoGasKit
import WidgetKit

// What you choose when editing a widget: the fuel grade, and for the Station widget, which
// station. Stations come from the store list bundled with the widget.

enum GradeOption: String, AppEnum, CaseIterable {
    case regular, premium, diesel

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Fuel"
    static var caseDisplayRepresentations: [GradeOption: DisplayRepresentation] = [
        .regular: "Regular", .premium: "Premium", .diesel: "Diesel"
    ]

    var grade: Grade { Grade(rawValue: rawValue) ?? .regular }
}

struct StationEntity: AppEntity {
    let id: String // "CA_Turlock"
    let name: String
    let address: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Station"
    static var defaultQuery = StationQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(address)")
    }
}

struct StationQuery: EntityStringQuery {
    /// Every warehouse in the bundled store list, sorted by state then city.
    static func all() -> [StationEntity] {
        guard let url = Bundle.main.url(forResource: "us_stores", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let directory = try? StoreDirectory(data: data) else { return [] }
        return directory.states.keys.sorted().flatMap { state in
            (directory.states[state] ?? [:]).keys.sorted().map { city in
                StationEntity(id: Station.key(state: state, city: city), name: "\(city), \(state)",
                              address: formatAddress(directory.states[state]?[city]?.address))
            }
        }
    }

    func entities(for identifiers: [StationEntity.ID]) async throws -> [StationEntity] {
        let wanted = Set(identifiers)
        return Self.all().filter { wanted.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [StationEntity] {
        let q = string.lowercased().trimmingCharacters(in: .whitespaces)
        return Self.all().filter { $0.name.lowercased().contains(q) || $0.address.lowercased().contains(q) }
    }

    func suggestedEntities() async throws -> [StationEntity] {
        Self.all()
    }
}

struct NearbyWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Cheapest nearby"
    static var description = IntentDescription("The cheapest Costco gas near you.")

    @Parameter(title: "Fuel", default: .regular)
    var grade: GradeOption
}

struct StationWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Station"
    static var description = IntentDescription("One Costco station's prices.")

    @Parameter(title: "Station")
    var station: StationEntity?

    @Parameter(title: "Fuel", default: .regular)
    var grade: GradeOption
}
