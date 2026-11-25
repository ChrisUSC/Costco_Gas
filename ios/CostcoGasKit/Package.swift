// swift-tools-version:5.9
// The app's logic with no UI: data formats, prices, hours, time, geometry, routing and
// geocoding. Ports of public/js (prices.js, hours.js, time.js, geo.js, stores.js, charts.js)
// so the iOS app and the website read the same data the same way. Foundation only, so
// `swift test` runs it without a simulator.
import PackageDescription

let package = Package(
    name: "CostcoGasKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CostcoGasKit", targets: ["CostcoGasKit"])
    ],
    targets: [
        .target(name: "CostcoGasKit"),
        .testTarget(name: "CostcoGasKitTests", dependencies: ["CostcoGasKit"])
    ]
)
