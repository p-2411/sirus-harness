import SwiftUI

@main struct SirusRemoteApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        // Titles in the TUI's arctic white, the large one lighter than the
        // system's bold.
        let white = UIColor(red: 0xF2 / 255, green: 0xF3 / 255, blue: 0xF5 / 255, alpha: 1)
        let bar = UINavigationBar.appearance()
        bar.largeTitleTextAttributes = [.font: UIFont.systemFont(ofSize: 32, weight: .semibold), .foregroundColor: white]
        bar.titleTextAttributes = [.font: UIFont.systemFont(ofSize: 16, weight: .semibold), .foregroundColor: white]
    }

    var body: some Scene {
        WindowGroup { RootView(store: delegate.store) }
    }
}
