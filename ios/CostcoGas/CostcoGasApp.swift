import Observation
import SwiftUI
import UIKit

@main
struct CostcoGasApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
                .environment(QuickActions.shared)
        }
    }
}

/// Home-screen quick actions (the website manifest's shortcuts): open on a given tab.
@MainActor
@Observable
final class QuickActions {
    static let shared = QuickActions()
    var pendingTab: AppTab?

    func handle(_ item: UIApplicationShortcutItem) -> Bool {
        guard let tab = AppTab(rawValue: item.type.replacingOccurrences(of: "tab.", with: "")) else { return false }
        pendingTab = tab
        return true
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if let item = options.shortcutItem { _ = QuickActions.shared.handle(item) }
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        completionHandler(QuickActions.shared.handle(shortcutItem))
    }
}
