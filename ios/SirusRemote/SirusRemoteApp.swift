import SwiftUI

@main struct SirusRemoteApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup { RootView(store: delegate.store) }
    }
}
