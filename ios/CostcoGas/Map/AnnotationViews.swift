import CostcoGasKit
import MapKit
import UIKit

/// One station on the map, carrying the selected grade's price.
final class StationAnnotation: NSObject, MKAnnotation {
    let station: Station
    let price: Double?
    let coordinate: CLLocationCoordinate2D

    init(station: Station, grade: Grade, coordinate: LatLng) {
        self.station = station
        self.price = station.price(grade)
        self.coordinate = coordinate.clCoordinate
    }

    var title: String? { station.name }
    var subtitle: String? { formatPrice(price) }
}

/// The route's start and end, and a searched place.
final class MarkerAnnotation: NSObject, MKAnnotation {
    enum Kind { case start, end, place }
    let kind: Kind
    let coordinate: CLLocationCoordinate2D
    let title: String?

    init(kind: Kind, place: Place) {
        self.kind = kind
        self.coordinate = place.coordinate.clCoordinate
        switch kind {
        case .start: title = "Start: \(place.label)"
        case .end: title = "End: \(place.label)"
        case .place: title = place.label
        }
    }
}

extension PriceTier {
    var color: UIColor {
        switch self {
        case .low: return .systemGreen
        case .mid: return .systemOrange
        case .high: return .systemRed
        case .flat: return UIColor(red: 0, green: 0x5D / 255, blue: 0xAA / 255, alpha: 1)
        case .none: return .systemGray
        }
    }
}

/// A price pill when zoomed in, a small dot when zoomed far out.
final class StationPinView: MKAnnotationView {
    static let reuseID = "station"
    static let clusterID = "stations"

    private let label = UILabel()

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        label.font = .monospacedDigitSystemFont(ofSize: 13, weight: .bold)
        label.textColor = .white
        label.textAlignment = .center
        addSubview(label)
        layer.borderColor = UIColor.white.cgColor
        layer.borderWidth = 1.5
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.25
        layer.shadowRadius = 2
        layer.shadowOffset = CGSize(width: 0, height: 1)
        canShowCallout = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(tier: PriceTier, compact: Bool, clustering: Bool) {
        guard let station = annotation as? StationAnnotation else { return }
        clusteringIdentifier = clustering ? StationPinView.clusterID : nil
        displayPriority = clustering ? .defaultHigh : .required
        collisionMode = .rectangle
        backgroundColor = tier.color

        if compact {
            label.isHidden = true
            bounds = CGRect(x: 0, y: 0, width: 14, height: 14)
            layer.cornerRadius = 7
            centerOffset = .zero
        } else {
            label.isHidden = false
            label.text = formatPrice(station.price)
            label.sizeToFit()
            let size = CGSize(width: label.bounds.width + 14, height: 24)
            bounds = CGRect(origin: .zero, size: size)
            label.frame = bounds
            layer.cornerRadius = size.height / 2
            centerOffset = CGPoint(x: 0, y: -size.height / 2)
        }
        accessibilityLabel = "\(station.station.name), \(formatPrice(station.price))"
        isAccessibilityElement = true
    }
}

/// Nearby stations merged into a bubble with the count and the cheapest price among them.
final class StationClusterView: MKAnnotationView {
    static let reuseID = "cluster"

    private let countLabel = UILabel()
    private let priceLabel = UILabel()

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        countLabel.font = .systemFont(ofSize: 14, weight: .bold)
        priceLabel.font = .monospacedDigitSystemFont(ofSize: 10, weight: .semibold)
        for l in [countLabel, priceLabel] {
            l.textColor = .white
            l.textAlignment = .center
            addSubview(l)
        }
        backgroundColor = UIColor(red: 0, green: 0x5D / 255, blue: 0xAA / 255, alpha: 0.92)
        layer.borderColor = UIColor.white.cgColor
        layer.borderWidth = 2
        displayPriority = .required
        collisionMode = .circle
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure() {
        guard let cluster = annotation as? MKClusterAnnotation else { return }
        let members = cluster.memberAnnotations.compactMap { $0 as? StationAnnotation }
        let cheapest = members.compactMap(\.price).min()
        let count = cluster.memberAnnotations.count
        let size: CGFloat = count >= 100 ? 58 : (count >= 10 ? 52 : 46)
        bounds = CGRect(x: 0, y: 0, width: size, height: size)
        layer.cornerRadius = size / 2
        countLabel.text = "\(count)"
        priceLabel.text = cheapest.map { "\(formatPrice($0))+" }
        priceLabel.isHidden = cheapest == nil
        if cheapest == nil {
            countLabel.frame = bounds
        } else {
            countLabel.frame = CGRect(x: 0, y: size * 0.18, width: size, height: size * 0.4)
            priceLabel.frame = CGRect(x: 0, y: size * 0.55, width: size, height: size * 0.25)
        }
        isAccessibilityElement = true
        accessibilityLabel = "\(count) stations" + (cheapest.map { ", from \(formatPrice($0))" } ?? "")
        accessibilityHint = "Zooms in"
    }
}
