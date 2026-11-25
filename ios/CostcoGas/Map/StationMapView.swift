import CostcoGasKit
import MapKit
import SwiftUI

/// The station map (the website's map.js and markers.js): pins that cluster when zoomed far
/// out, become dots, then price pills as you zoom in; optional price colours; the route line;
/// the searched place; and the user's location.
struct StationMapView: UIViewRepresentable {
    var stations: [Station]
    var grade: Grade
    var clustering: Bool
    var colorPins: Bool
    var route: RouteResult?
    var searchedPlace: Place?
    var showsUserLocation: Bool
    var request: MapRequest?
    /// Space covered by the bottom sheet, so moves centre on the part of the map in view.
    var bottomInset: CGFloat
    var onSelect: (Station) -> Void
    var onRegionChange: (LatLng, Double, PriceTierScale) -> Void

    /// Wider than this (in degrees of longitude), stations cluster and show as dots: about
    /// zoom level 8 on a phone, where the website stops clustering.
    static let wideSpan: Double = 2.0

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.register(StationPinView.self, forAnnotationViewWithReuseIdentifier: StationPinView.reuseID)
        map.register(StationClusterView.self, forAnnotationViewWithReuseIdentifier: StationClusterView.reuseID)
        map.register(MKMarkerAnnotationView.self, forAnnotationViewWithReuseIdentifier: "marker")
        map.pointOfInterestFilter = .excludingAll
        map.showsCompass = true
        map.showsScale = true
        // The contiguous US until the prices arrive.
        map.setRegion(MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 39.5, longitude: -98.35),
                                         span: MKCoordinateSpan(latitudeDelta: 30, longitudeDelta: 60)), animated: false)
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        if map.showsUserLocation != showsUserLocation { map.showsUserLocation = showsUserLocation }
        coordinator.syncStations(on: map)
        coordinator.syncRoute(on: map)
        coordinator.syncPlace(on: map)
        if let request, request.id != coordinator.lastRequestID {
            coordinator.lastRequestID = request.id
            coordinator.perform(request.command, on: map)
        }
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        var parent: StationMapView
        var lastRequestID: UUID?
        private var stationSignature: Int?
        private var stationAnnotations: [StationAnnotation] = []
        private var routeSignature: String?
        private var routeOverlay: MKPolyline?
        private var routeMarkers: [MarkerAnnotation] = []
        private var placeMarker: MarkerAnnotation?
        private var isWide = true
        private var tierScale = PriceTierScale(pricesInView: [], enabled: false)

        init(_ parent: StationMapView) {
            self.parent = parent
        }

        // MARK: Pins

        func syncStations(on map: MKMapView) {
            isWide = map.region.span.longitudeDelta > StationMapView.wideSpan
            var hasher = Hasher()
            hasher.combine(parent.grade)
            hasher.combine(parent.clustering && isWide)
            hasher.combine(isWide)
            for s in parent.stations {
                hasher.combine(s.id)
                hasher.combine(s.price(parent.grade))
            }
            let signature = hasher.finalize()
            guard signature != stationSignature else { return }
            stationSignature = signature

            map.removeAnnotations(stationAnnotations)
            stationAnnotations = parent.stations.compactMap { s in
                s.coordinate.map { StationAnnotation(station: s, grade: parent.grade, coordinate: $0) }
            }
            map.addAnnotations(stationAnnotations)
            DispatchQueue.main.async { [weak self, weak map] in
                guard let self, let map else { return }
                self.updateTiers(on: map)
            }
        }

        /// Colours pins by where their price sits among the stations in view.
        func updateTiers(on map: MKMapView) {
            let rect = map.visibleMapRect
            let inView = stationAnnotations.filter { rect.contains(MKMapPoint($0.coordinate)) }
            tierScale = PriceTierScale(pricesInView: inView.compactMap(\.price), enabled: parent.colorPins)
            for annotation in inView {
                (map.view(for: annotation) as? StationPinView)?
                    .configure(tier: tierScale.tier(for: annotation.price), compact: isWide, clustering: parent.clustering && isWide)
            }
            let center = LatLng(map.region.center)
            let span = map.region.span.longitudeDelta
            let scale = tierScale
            DispatchQueue.main.async { self.parent.onRegionChange(center, span, scale) }
        }

        func mapView(_ map: MKMapView, regionDidChangeAnimated animated: Bool) {
            let wide = map.region.span.longitudeDelta > StationMapView.wideSpan
            if wide != isWide {
                syncStations(on: map) // re-cluster, and switch between dots and price pills
            } else {
                updateTiers(on: map)
            }
        }

        func mapView(_ map: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if annotation is MKUserLocation { return nil }
            if let cluster = annotation as? MKClusterAnnotation {
                let view = map.dequeueReusableAnnotationView(withIdentifier: StationClusterView.reuseID, for: cluster)
                (view as? StationClusterView)?.configure()
                return view
            }
            if let station = annotation as? StationAnnotation {
                let view = map.dequeueReusableAnnotationView(withIdentifier: StationPinView.reuseID, for: station)
                (view as? StationPinView)?.configure(tier: tierScale.tier(for: station.price), compact: isWide,
                                                     clustering: parent.clustering && isWide)
                return view
            }
            if let marker = annotation as? MarkerAnnotation {
                let view = map.dequeueReusableAnnotationView(withIdentifier: "marker", for: marker)
                if let view = view as? MKMarkerAnnotationView {
                    view.canShowCallout = true
                    view.displayPriority = .required
                    switch marker.kind {
                    case .start: view.markerTintColor = .systemGreen; view.glyphImage = UIImage(systemName: "flag")
                    case .end: view.markerTintColor = .systemRed; view.glyphImage = UIImage(systemName: "flag.checkered")
                    case .place: view.markerTintColor = .systemIndigo; view.glyphImage = UIImage(systemName: "mappin")
                    }
                }
                return view
            }
            return nil
        }

        func mapView(_ map: MKMapView, didSelect view: MKAnnotationView) {
            if let cluster = view.annotation as? MKClusterAnnotation {
                map.deselectAnnotation(cluster, animated: false)
                map.showAnnotations(cluster.memberAnnotations, animated: true)
                return
            }
            if let annotation = view.annotation as? StationAnnotation {
                map.deselectAnnotation(annotation, animated: false)
                let station = annotation.station
                DispatchQueue.main.async { self.parent.onSelect(station) }
            }
        }

        // MARK: Route and place

        func syncRoute(on map: MKMapView) {
            let route = parent.route
            let signature = route.map { r in
                "\(r.origin.lat),\(r.origin.lng)|\(r.destination.lat),\(r.destination.lng)|\(r.route.coords.count)|\(r.route.distanceMiles)"
            }
            guard signature != routeSignature else { return }
            routeSignature = signature
            if let routeOverlay { map.removeOverlay(routeOverlay) }
            map.removeAnnotations(routeMarkers)
            routeOverlay = nil
            routeMarkers = []
            guard let route else { return }
            var coords = route.route.coords.map(\.clCoordinate)
            let line = MKPolyline(coordinates: &coords, count: coords.count)
            map.addOverlay(line, level: .aboveRoads)
            routeOverlay = line
            routeMarkers = [MarkerAnnotation(kind: .start, place: route.origin), MarkerAnnotation(kind: .end, place: route.destination)]
            map.addAnnotations(routeMarkers)
        }

        func syncPlace(on map: MKMapView) {
            let place = parent.searchedPlace
            if placeMarker?.title == place?.label && placeMarker?.coordinate.latitude == place?.lat { return }
            if let placeMarker { map.removeAnnotation(placeMarker) }
            placeMarker = place.map { MarkerAnnotation(kind: .place, place: $0) }
            if let placeMarker { map.addAnnotation(placeMarker) }
        }

        func mapView(_ map: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            guard let line = overlay as? MKPolyline else { return MKOverlayRenderer(overlay: overlay) }
            let renderer = MKPolylineRenderer(polyline: line)
            renderer.strokeColor = UIColor(red: 0, green: 0x5D / 255, blue: 0xAA / 255, alpha: 0.75)
            renderer.lineWidth = 5
            return renderer
        }

        // MARK: Moving the map

        func perform(_ command: MapRequest.Command, on map: MKMapView) {
            let padding = UIEdgeInsets(top: 50, left: 40, bottom: 40 + parent.bottomInset, right: 40)
            switch command {
            case .center(let point, let span):
                let half = span / 2
                let a = MKMapPoint(CLLocationCoordinate2D(latitude: min(point.lat + half, 85), longitude: point.lng - half))
                let b = MKMapPoint(CLLocationCoordinate2D(latitude: max(point.lat - half, -85), longitude: point.lng + half))
                let rect = MKMapRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
                map.setVisibleMapRect(rect, edgePadding: padding, animated: !UIAccessibility.isReduceMotionEnabled)
            case .fit(let points):
                guard !points.isEmpty else { return }
                var rect = MKMapRect.null
                for p in points {
                    let mp = MKMapPoint(p.clCoordinate)
                    rect = rect.union(MKMapRect(x: mp.x, y: mp.y, width: 0.1, height: 0.1))
                }
                map.setVisibleMapRect(rect, edgePadding: padding, animated: !UIAccessibility.isReduceMotionEnabled)
            }
        }
    }
}
