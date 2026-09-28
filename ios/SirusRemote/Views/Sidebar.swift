import SwiftUI

// src/frontend/Sidebar.tsx on the phone, floating over the conversation.
// Collapsed, a slim glass rail on the leading edge with one mark per session;
// expanded, a glass panel naming them, with the Mac they come from. It is one
// pane of glass that springs between the two, its toggle staying put. It
// opens from the toggle or a swipe in from the edge, and closes from the
// toggle, a tap beside it, a swipe back, or a session picked.
struct Sidebar: View {
    static let inset: CGFloat = 12
    static let railWidth: CGFloat = 48
    static let panelRadius: CGFloat = 34
    // Controls in the panel's corners sit concentric with them: in from each
    // edge by the corner's radius less their own.
    static let cornerInset = panelRadius - railWidth / 2
    // How far in the header sits from each edge: clear of the rail, and
    // centred on the screen.
    static let gutter = inset + railWidth + 12
    // What the header's agent tabs keep clear of on each side: just the rail.
    static let clearance = inset + railWidth + 2
    // From the sidebar's top to where the rail's marks begin: the toggle,
    // then the rule under it.
    private static let marksTop: CGFloat = 2 + 48 + 5

    let store: RemoteStore
    let selected: String?
    @Binding var expanded: Bool
    // Where on screen the rail must end: above the conversation's bottom
    // bar, so a request card there is never under it.
    var railEnd: CGFloat = .infinity
    // The sidebar's own top on screen, which the rail's height can't move.
    @State private var top: CGFloat = 0
    @State private var seen: [String: Int] = [:]
    @State private var confirmingForget = false
    @GestureState private var drag: CGFloat = 0

    var body: some View {
        ZStack(alignment: .topLeading) {
            if expanded {
                Color.black.opacity(0.4)
                    .ignoresSafeArea()
                    .onTapGesture { setExpanded(false) }
                    .accessibilityLabel("Hide Sessions")
                    .accessibilityAddTraits(.isButton)
                    .transition(.opacity)
            } else {
                Color.clear
                    .frame(width: 16)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 12).onEnded { value in
                        if value.translation.width > 40 { setExpanded(true) }
                    })
                    .ignoresSafeArea()
            }
            pane
                .padding(.leading, Self.inset)
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { top = $0 }
        .sensoryFeedback(.selection, trigger: selected)
        .sensoryFeedback(.impact(weight: .light), trigger: expanded)
        // Forgetting the Mac leaves only setup, and connecting again needs
        // its name or QR code, so it asks first.
        .confirmationDialog("Change Mac?", isPresented: $confirmingForget, titleVisibility: .visible) {
            Button("Forget \(store.host)", role: .destructive) {
                setExpanded(false)
                store.forget()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("To connect again, scan the code `/rc` shows on your Mac or enter its name.")
        }
        .onChange(of: store.sessions, initial: true) { _, sessions in
            // As in the TUI's sidebar: a session is unread once an agent
            // wrote something while another session was open.
            for session in sessions where seen[session.id] == nil || session.id == selected {
                seen[session.id] = session.assistantVersion
            }
        }
        .onChange(of: selected) { _, id in
            if let id, let session = store.session(id) { seen[id] = session.assistantVersion }
        }
    }

    private var pane: some View {
        let shape = RoundedRectangle(cornerRadius: expanded ? Self.panelRadius : Self.railWidth / 2, style: .continuous)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                toggle
                if expanded {
                    Spacer(minLength: 0)
                    Menu {
                        Button("Look Again", systemImage: "arrow.clockwise") { Task { await store.rescan() } }
                        Button("Change Mac…", systemImage: "desktopcomputer", role: .destructive) {
                            confirmingForget = true
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Palette.platinum)
                            .frame(width: 48, height: 48)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("More")
                    .transition(.opacity)
                }
            }
            .padding([.top, .horizontal], expanded ? Self.cornerInset : 0)
            if expanded {
                panel.transition(.opacity)
            } else if !store.sessions.isEmpty {
                rail.transition(.opacity)
            }
        }
        .containerRelativeFrame(.horizontal, alignment: .leading) { width, _ in
            expanded ? min(340, width - 60) : Self.railWidth
        }
        .frame(maxHeight: expanded ? .infinity : nil, alignment: .top)
        .clipShape(shape)
        .glassEffect(.regular, in: shape)
        .offset(x: drag)
        .simultaneousGesture(DragGesture(minimumDistance: 16)
            .updating($drag) { value, state, _ in
                if expanded, abs(value.translation.width) > abs(value.translation.height) {
                    state = min(0, value.translation.width)
                }
            }
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                if expanded, value.translation.width < -60 { setExpanded(false) }
                if !expanded, value.translation.width > 30 { setExpanded(true) }
            })
    }

    // One mark per session, the open one picked out.
    private var rail: some View {
        VStack(spacing: 0) {
            Capsule().fill(Palette.line).frame(width: 20, height: 1).padding(.bottom, 4)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(store.sessions) { session in
                        Button { select(session.id) } label: {
                            StatusMark(mark: mark(session))
                                .opacity(reachable(session) ? 1 : 0.35)
                                .frame(width: 36, height: 36)
                                .background {
                                    if session.id == selected { Circle().fill(.white.opacity(0.13)) }
                                }
                                .frame(width: Self.railWidth, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(session.name)
                        .accessibilityValue(mark(session).description)
                        .accessibilityAddTraits(session.id == selected ? .isSelected : [])
                    }
                }
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            // Seven marks at most, fewer when the bottom bar comes up to
            // meet it, down to none; the rest scroll.
            .frame(height: min(min(CGFloat(store.sessions.count), 7) * 44, max(0, railEnd - top - Self.marksTop - 12)))
        }
        .frame(width: Self.railWidth)
        .padding(.bottom, 4)
    }

    // The sessions by name, directory and last activity, over the Mac.
    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Sessions")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(Palette.white)
                .padding(.horizontal, 18)
                .padding(.top, 2)
                .padding(.bottom, 10)
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(store.sessions) { session in
                        Button { select(session.id) } label: { row(session) }
                            .accessibilityValue(mark(session).description)
                            .accessibilityAddTraits(session.id == selected ? .isSelected : [])
                            .buttonStyle(RowPress())
                    }
                }
                .padding(.horizontal, 8)
            }
            .scrollIndicators(.hidden)
            .refreshable { await store.rescan() }
            .overlay {
                if store.sessions.isEmpty {
                    // Connecting is not empty: the list is on its way.
                    if store.link == .connecting {
                        ProgressView()
                            .tint(Palette.silver)
                            .accessibilityLabel("Connecting")
                    } else {
                        Text(store.link == .live
                             ? "Nothing is remote controlled yet. Run `/rc` in a Sirus session on your Mac."
                             : "Can't reach \(store.host).")
                            .font(.system(size: 15))
                            .foregroundStyle(Palette.muted)
                            .multilineTextAlignment(.center)
                            .padding(24)
                    }
                }
            }
            Hairline().padding(.horizontal, 18)
            LinkLine(store: store)
                .padding(.horizontal, 18)
                .frame(height: 52)
        }
    }

    private var toggle: some View {
        Button { setExpanded(!expanded) } label: {
            Image(systemName: "sidebar.leading")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Palette.platinum)
                .frame(width: Self.railWidth, height: 48)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(expanded ? "Hide Sessions" : "Show Sessions")
    }

    private func row(_ session: RemoteSession) -> some View {
        let current = session.id == selected
        return HStack(alignment: .top, spacing: 12) {
            StatusMark(mark: mark(session)).opacity(reachable(session) ? 1 : 0.35).frame(width: 20, height: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(session.name)
                    .font(.system(size: 16, weight: current ? .semibold : .regular))
                    .foregroundStyle(current ? Palette.white : Palette.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(session.directory)
                    .font(.mono(12))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: 8)
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(ago(session.lastActivity, now: context.date))
                    .font(.mono(11))
                    .foregroundStyle(Palette.subtle)
            }
            .padding(.top, 3)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 11)
        .background {
            if current { RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Palette.fill) }
        }
        .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    // As sessionStatusAppearance: waiting on the user, then working or a
    // failed turn, then unread or idle.
    private func mark(_ session: RemoteSession) -> SessionMark {
        if session.needsYou { return .attention }
        if session.working { return .working }
        if session.failed { return .error }
        let unread = session.id != selected && session.assistantVersion > seen[session.id, default: .max]
        return unread ? .unread : .idle
    }

    // A session whose Sirus can't be reached keeps its last mark, faded:
    // the TUI has no such state, and the link line says why.
    private func reachable(_ session: RemoteSession) -> Bool {
        store.client(for: session.id)?.link != .offline
    }

    private func select(_ id: String) {
        store.open(id)
        if expanded { setExpanded(false) }
    }

    private func setExpanded(_ value: Bool) {
        if value { dismissKeyboard() }
        withAnimation(.spring(duration: 0.45, bounce: 0.16)) { expanded = value }
    }
}

enum SessionMark: CustomStringConvertible {
    case idle, unread, working, attention, error

    var description: String {
        switch self {
        case .idle: "idle"
        case .unread: "new activity"
        case .working: "working"
        case .attention: "needs you"
        case .error: "last turn failed"
        }
    }
}

// SESSION_STATUS_APPEARANCE in symbols: idle ○ in graphite, unread ● a step
// lighter so it shows on glass, a turning amber mark while working, an amber
// ! when waiting on the user, a red ● for an error.
struct StatusMark: View {
    let mark: SessionMark

    var body: some View {
        switch mark {
        case .idle:
            dot("circle", Palette.subtle)
        case .unread:
            dot("circle.fill", Palette.muted)
        case .working:
            Image(systemName: "progress.indicator")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.amber)
                .symbolEffect(.variableColor.iterative, options: .repeating)
        case .attention:
            Image(systemName: "exclamationmark")
                .font(.system(size: 15, weight: .heavy))
                .foregroundStyle(Palette.amber)
                .symbolEffect(.bounce, options: .repeat(.periodic(delay: 1.8)))
        case .error:
            dot("circle.fill", Palette.red)
        }
    }

    private func dot(_ name: String, _ color: Color) -> some View {
        Image(systemName: name)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(color)
    }
}

// Which Mac, and whether the app is talking to it.
private struct LinkLine: View {
    let store: RemoteStore

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: store.link == .offline ? "wifi.slash" : "desktopcomputer")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(color)
                .symbolEffect(.pulse, isActive: store.link == .connecting || store.scanning)
            Text(store.host)
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            Text(caption).foregroundStyle(Palette.subtle)
        }
        .font(.mono(12))
    }

    private var color: Color {
        switch store.link {
        case .live: Palette.platinum
        case .connecting: Palette.muted
        case .offline: Palette.muted
        }
    }

    // A look under way comes first, so Look Again and pull to refresh show
    // they are doing something even while connected.
    private var caption: String {
        if store.scanning { return "looking…" }
        switch store.link {
        case .live: return store.clients.count > 1 ? "\(store.clients.filter { $0.link == .live }.count) processes" : "connected"
        case .connecting: return "connecting"
        case .offline: return "offline"
        }
    }
}
