import SwiftUI

// The participants as the TUI header lists them, in a glass capsule: the
// selected one on a lighter thumb, a working one breathing silver, one
// waiting on the user marked. As many as fit are shown, the selected one
// always; the rest sit behind a +N chip that carries their marks.
struct AgentTabs: View {
    let participants: [Participant]
    let selected: String
    let choose: (String) -> Void
    @State private var width: CGFloat = 0
    @Namespace private var thumb

    // Names are monospaced, so a tab's width is known without measuring.
    private static let character: CGFloat = 7.8
    private static let chip: CGFloat = 60

    var body: some View {
        let (shown, hidden) = split()
        HStack(spacing: 0) {
            ForEach(shown) { tab($0) }
            if !hidden.isEmpty { overflow(hidden) }
        }
        .padding(4)
        .glassEffect(.regular, in: .capsule)
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .sensoryFeedback(.selection, trigger: selected)
        .animation(.spring(duration: 0.35, bounce: 0.2), value: selected)
    }

    private func tabWidth(_ agent: Participant) -> CGFloat {
        CGFloat(agent.name.count) * Self.character + 28 + (agent.needsYou || agent.working ? 12 : 0)
    }

    // In order while they fit, keeping room for the chip if any are left
    // over; the selected agent takes the last place if it did not fit.
    private func split() -> ([Participant], [Participant]) {
        let room = width - 8
        guard width > 0, participants.map(tabWidth).reduce(0, +) > room else { return (participants, []) }
        var shown: [Participant] = []
        var used: CGFloat = Self.chip
        for agent in participants where used + tabWidth(agent) <= room {
            shown.append(agent)
            used += tabWidth(agent)
        }
        if !shown.contains(where: { $0.name == selected }), let current = participants.first(where: { $0.name == selected }) {
            if !shown.isEmpty, used + tabWidth(current) > room { shown.removeLast() }
            shown.append(current)
        }
        let names = Set(shown.map(\.name))
        return (participants.filter { names.contains($0.name) }, participants.filter { !names.contains($0.name) })
    }

    private func tab(_ agent: Participant) -> some View {
        let active = agent.name == selected
        return Button { choose(agent.name) } label: {
            HStack(spacing: 6) {
                Text(agent.name)
                    .font(.mono(13, active ? .semibold : .regular))
                    .foregroundStyle(active ? Palette.white : Palette.muted)
                    .lineLimit(1)
                mark(needsYou: agent.needsYou, working: agent.working)
            }
            .fixedSize()
            .padding(.horizontal, 14)
            .frame(minWidth: 44, minHeight: 36)
            .background {
                if active { Capsule().fill(.white.opacity(0.14)).matchedGeometryEffect(id: "thumb", in: thumb) }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    // The agents that did not fit, and the most urgent of their marks.
    private func overflow(_ hidden: [Participant]) -> some View {
        Menu {
            ForEach(hidden) { agent in
                Button {
                    choose(agent.name)
                } label: {
                    Label(agent.name, systemImage: agent.needsYou ? "exclamationmark" : agent.working ? "circle.fill" : "circle")
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text("+\(hidden.count)").font(.mono(13)).foregroundStyle(Palette.muted)
                mark(needsYou: hidden.contains(where: \.needsYou), working: hidden.contains(where: \.working))
            }
            .fixedSize()
            .padding(.horizontal, 12)
            .frame(minWidth: 44, minHeight: 36)
            .contentShape(Capsule())
        }
        .accessibilityLabel("\(hidden.count) more agents")
    }

    @ViewBuilder private func mark(needsYou: Bool, working: Bool) -> some View {
        if needsYou {
            Image(systemName: "exclamationmark")
                .font(.system(size: 11, weight: .heavy))
                .foregroundStyle(Palette.amber)
                .symbolEffect(.bounce, options: .repeat(.periodic(delay: 1.8)))
        } else if working {
            Image(systemName: "circle.fill")
                .font(.system(size: 6))
                .foregroundStyle(Palette.silver)
                .symbolEffect(.pulse, options: .repeating)
        }
    }
}
