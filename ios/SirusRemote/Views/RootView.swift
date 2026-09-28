import SwiftUI

// Setup until a Mac is known, then the sessions, with the open one pushed on
// top. Links from the QR code and notification taps land here.
struct RootView: View {
    @Bindable var store: RemoteStore
    @Environment(\.scenePhase) private var phase

    var body: some View {
        NavigationStack {
            Group {
                if store.host.isEmpty { SetupView(store: store) } else { SessionsView(store: store) }
            }
            .navigationDestination(item: $store.openSession) { id in
                ConversationView(store: store, sessionId: id)
            }
        }
        .tint(Palette.platinum)
        .preferredColorScheme(.dark)
        .onOpenURL { url in
            guard url.scheme == "sirus", url.host() == "connect" else { return }
            Task { await store.connect(to: url.absoluteString) }
        }
        .task { store.foreground() }
        .onChange(of: phase) { _, phase in
            switch phase {
            case .active: store.foreground()
            case .background: store.background()
            default: break
            }
        }
    }
}

extension View {
    // The ground under every screen. A screen whose content scrolls under the
    // navigation bar draws the bar on the ground too; the list lets the large
    // title sit on it bare.
    func sirusScreen(bar: Bool = true) -> some View {
        background(Palette.ground.ignoresSafeArea())
            .toolbarBackground(Palette.ground, for: .navigationBar)
            .toolbarBackground(bar ? .visible : .hidden, for: .navigationBar)
    }
}
