import SwiftUI

// Setup until a Mac is known; then one screen, the open session's
// conversation with the sidebar floating over its leading edge. Links from
// the QR code and notification taps land here.
struct RootView: View {
    @Bindable var store: RemoteStore
    @Environment(\.scenePhase) private var phase
    @AppStorage("sidebarExpanded") private var sidebarExpanded = false

    var body: some View {
        Group {
            if store.host.isEmpty {
                SetupView(store: store)
            } else {
                ZStack {
                    if let id = store.openSession {
                        ConversationView(store: store, sessionId: id)
                            .id(id)
                            .transition(.opacity)
                    } else {
                        Lobby(store: store)
                    }
                    Sidebar(store: store, selected: store.openSession, expanded: $sidebarExpanded)
                        .ignoresSafeArea(.keyboard)
                }
                .animation(.smooth(duration: 0.25), value: store.openSession)
            }
        }
        .background(Palette.ground.ignoresSafeArea())
        .tint(Palette.platinum)
        .preferredColorScheme(.dark)
        .onChange(of: store.sessions.first?.id, initial: true) { _, first in
            // Nothing opened at launch: show the most recent session.
            if store.openSession == nil, let first { store.open(first) }
        }
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

// No session open: still reaching the Mac, unable to, or nothing on it is
// remote controlled yet.
private struct Lobby: View {
    let store: RemoteStore

    var body: some View {
        VStack(spacing: 12) {
            Image("Horse")
                .resizable()
                .scaledToFit()
                .frame(width: 64)
                .foregroundStyle(Palette.line)
                .padding(.bottom, 8)
            Text(title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Palette.text)
            if let detail {
                Text(LocalizedStringKey(detail))
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.muted)
            }
            if store.link != .connecting {
                Button { Task { await store.rescan() } } label: {
                    Label(store.link == .offline ? "Try Again" : "Look Again", systemImage: "arrow.clockwise")
                        .font(.system(size: 15, weight: .medium))
                        .padding(.horizontal, 6)
                        .frame(minHeight: 36)
                }
                .buttonStyle(.glass)
                .padding(.top, 12)
            }
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.smooth, value: store.link)
    }

    private var title: String {
        switch store.link {
        case .connecting: "Connecting to \(store.host)…"
        case .offline: "Can't reach \(store.host)"
        case .live: "No sessions yet"
        }
    }

    private var detail: String? {
        switch store.link {
        case .connecting: nil
        case .offline: store.problem ?? "Check that Sirus is running on your Mac and Tailscale is on here."
        case .live: "Run `/rc` in a Sirus session on your Mac."
        }
    }
}
