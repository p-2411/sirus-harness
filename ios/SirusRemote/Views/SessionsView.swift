import SwiftUI

// Every `/rc` session on the Mac, from every Sirus process on it, the most
// recently active first.
struct SessionsView: View {
    let store: RemoteStore

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                LinkLine(store: store)
                    .padding(.top, 6)
                    .padding(.bottom, 16)
                Hairline()
                ForEach(store.sessions) { session in
                    Button { store.open(session.id) } label: { SessionRow(session: session) }
                        .buttonStyle(RowPress())
                    Hairline()
                }
            }
            .padding(.horizontal, 24)
        }
        .scrollIndicators(.hidden)
        .overlay {
            if store.sessions.isEmpty && store.link != .connecting { EmptySessions(store: store) }
        }
        .refreshable { await store.rescan() }
        .navigationTitle("Sessions")
        .sirusScreen(bar: false)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Look Again", systemImage: "arrow.clockwise") { Task { await store.rescan() } }
                    Button("Change Mac", systemImage: "desktopcomputer") { store.forget() }
                } label: {
                    Image(systemName: "ellipsis").foregroundStyle(Palette.muted)
                }
            }
        }
    }
}

// Which Mac, and whether the app is talking to it.
private struct LinkLine: View {
    let store: RemoteStore

    var body: some View {
        HStack(spacing: 8) {
            switch store.link {
            case .live: Circle().fill(Palette.platinum).frame(width: 6, height: 6)
            case .connecting: Pulse(color: Palette.amber)
            case .offline: Circle().fill(Palette.red).frame(width: 6, height: 6)
            }
            Text(store.host).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.middle)
            Spacer()
            Text(caption).foregroundStyle(store.link == .offline ? Palette.red : Palette.subtle)
        }
        .font(.mono(11))
    }

    private var caption: String {
        switch store.link {
        case .live: store.clients.count > 1 ? "\(store.clients.filter { $0.link == .live }.count) processes" : "connected"
        case .connecting: "connecting"
        case .offline: "offline"
        }
    }
}

private struct SessionRow: View {
    let session: RemoteSession

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(session.name)
                    .font(.system(size: 17, weight: .regular))
                    .foregroundStyle(Palette.white)
                    .lineLimit(2)
                Text(session.directory)
                    .font(.mono(12))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(ago(session.lastActivity, now: context.date))
                        .font(.mono(11))
                        .foregroundStyle(Palette.subtle)
                }
                state
            }
        }
        .padding(.vertical, 18)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var state: some View {
        if session.needsYou {
            HStack(spacing: 6) {
                Circle().fill(Palette.amber).frame(width: 6, height: 6)
                Text("needs you")
            }
            .font(.mono(11, .medium))
            .foregroundStyle(Palette.amber)
        } else if session.working {
            HStack(spacing: 6) {
                Pulse(color: Palette.amber)
                Text("working")
            }
            .font(.mono(11))
            .foregroundStyle(Palette.amber.opacity(0.85))
        }
    }
}

private struct EmptySessions: View {
    let store: RemoteStore

    var body: some View {
        VStack(spacing: 16) {
            Image("Horse")
                .resizable()
                .scaledToFit()
                .frame(width: 72)
                .foregroundStyle(Palette.line)
            Text(store.problem ?? "No sessions yet")
                .font(.system(size: 16))
                .foregroundStyle(Palette.text)
                .multilineTextAlignment(.center)
            if store.problem == nil {
                Text("Run `/rc` in a Sirus session on your Mac.")
                    .font(.system(size: 14))
                    .foregroundStyle(Palette.muted)
            }
        }
        .padding(40)
    }
}

// Rows darken a touch under the finger instead of flashing grey.
struct RowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.55 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
