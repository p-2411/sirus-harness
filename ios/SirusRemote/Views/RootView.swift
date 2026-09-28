import SwiftUI

// Setup until a Mac is known; then one screen, the open session's
// conversation with the sidebar floating over its leading edge. Links from
// the QR code and notification taps land here.
struct RootView: View {
    @Bindable var store: RemoteStore
    @Environment(\.scenePhase) private var phase
    // Plain state, written through to the defaults: a change to @AppStorage
    // reaches the view outside the animation it was made in, so the sidebar
    // would snap instead of springing.
    @State private var sidebarExpanded = UserDefaults.standard.bool(forKey: "sidebarExpanded")
    @State private var menuOpen = false
    // A link to another Mac, waiting for the user to say yes.
    @State private var otherMac: String?
    @State private var confirmingOtherMac = false

    // A menu over the conversation takes its whole width, so the rail steps
    // aside until it closes.
    private var railAside: Bool { menuOpen && !sidebarExpanded }

    var body: some View {
        Group {
            if store.host.isEmpty {
                SetupView(store: store)
            } else {
                ZStack {
                    if let id = store.openSession {
                        ConversationView(store: store, sessionId: id, menuOpen: $menuOpen)
                            .id(id)
                            .transition(.opacity)
                    } else {
                        Lobby(store: store)
                    }
                    Sidebar(store: store, selected: store.openSession, expanded: $sidebarExpanded)
                        .ignoresSafeArea(.keyboard)
                        .opacity(railAside ? 0 : 1)
                        .allowsHitTesting(!railAside)
                        .symbolEffectsRemoved(railAside)
                }
                .animation(.smooth(duration: 0.25), value: store.openSession)
                .animation(.smooth(duration: 0.2), value: railAside)
            }
        }
        .background(Palette.ground.ignoresSafeArea())
        .tint(Palette.platinum)
        .preferredColorScheme(.dark)
        .onChange(of: sidebarExpanded) { _, expanded in
            UserDefaults.standard.set(expanded, forKey: "sidebarExpanded")
        }
        .onOpenURL { url in
            guard url.scheme == "sirus", url.host() == "connect" else { return }
            // A link can come from anywhere. Moving to another Mac sends it
            // messages, answers and this phone's push token, so that asks
            // first; the first Mac, or the same one again, does not.
            let target = HostScanner.normalize(url.absoluteString)
            if store.host.isEmpty || target == store.host {
                Task { await store.connect(to: url.absoluteString) }
            } else if let target {
                otherMac = target
                confirmingOtherMac = true
            }
        }
        .confirmationDialog("Switch to another Mac?", isPresented: $confirmingOtherMac,
                            titleVisibility: .visible, presenting: otherMac) { target in
            Button("Connect to \(target)") { Task { await store.connect(to: target) } }
            Button("Stay on \(store.host)", role: .cancel) {}
        } message: { target in
            Text("Sirus Remote is connected to \(store.host). After switching, your messages and approvals go to \(target).")
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

    // Unreachable is nearly always Tailscale, so what to check comes with it.
    private var showsChecklist: Bool {
        store.link == .offline && (store.problem?.concernsTailscale ?? true)
    }

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
            if showsChecklist {
                ConnectionHelp()
                    .frame(maxWidth: 400)
                    .padding(.top, 10)
                    .transition(.opacity)
            }
            if store.link == .connecting {
                ProgressView()
                    .tint(Palette.silver)
                    .padding(.top, 8)
            } else {
                Button { Task { await store.rescan() } } label: {
                    Label(store.link == .offline ? "Try Again" : "Look Again", systemImage: "arrow.clockwise")
                        .font(.system(size: 15, weight: .medium))
                        .padding(.horizontal, 6)
                        .frame(minHeight: 36)
                }
                .buttonStyle(.glass)
                .padding(.top, showsChecklist ? 4 : 12)
            }
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 24)
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

    // The checklist says what to try; a Mac that turned the phone away
    // also says so.
    private var detail: String? {
        switch store.link {
        case .connecting:
            return nil
        case .offline:
            if case .refused? = store.problem { return store.problem?.errorDescription }
            return showsChecklist ? nil : store.problem?.errorDescription
        case .live:
            return "Run `/rc` in a Sirus session on your Mac."
        }
    }
}
