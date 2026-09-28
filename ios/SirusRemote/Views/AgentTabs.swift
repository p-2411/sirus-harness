import SwiftUI

// The participants as the TUI header lists them, in a glass capsule: the
// selected one on a sliding thumb, a working one spinning silver, one
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
        .padding(6)
        .glassEffect(.regular, in: .capsule)
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .sensoryFeedback(.selection, trigger: selected)
        .animation(.spring(duration: 0.35, bounce: 0.2), value: selected)
    }

    private func tabWidth(_ agent: Participant) -> CGFloat {
        CGFloat(agent.name.count) * Self.character + 28 + (agent.needsYou || agent.working ? 19 : 0)
    }

    // In order while they fit, keeping room for the chip if any are left
    // over; the selected agent takes the last place if it did not fit.
    private func split() -> ([Participant], [Participant]) {
        let room = width - 12
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
        return Button { select(agent.name) } label: {
            HStack(spacing: 6) {
                ZStack {
                    Text(agent.name).font(.mono(13)).foregroundStyle(Palette.muted).opacity(active ? 0 : 1)
                    Text(agent.name).font(.mono(13, .semibold)).foregroundStyle(Palette.white).opacity(active ? 1 : 0)
                }
                .lineLimit(1)
                mark(needsYou: agent.needsYou, working: agent.working)
            }
            .fixedSize()
            .padding(.horizontal, 14)
            .frame(width: max(44, tabWidth(agent)), height: 36)
            .background {
                if active { Capsule().fill(.white.opacity(0.14)).matchedGeometryEffect(id: "thumb", in: thumb) }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(agent.name)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    // The agents that did not fit, and the most urgent of their marks.
    private func overflow(_ hidden: [Participant]) -> some View {
        Menu {
            ForEach(hidden) { agent in
                Button {
                    select(agent.name)
                } label: {
                    Label(agent.name, systemImage: agent.needsYou ? "exclamationmark" : agent.working ? "progress.indicator" : "circle")
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text("+\(hidden.count)").font(.mono(13)).foregroundStyle(Palette.muted)
                mark(needsYou: hidden.contains(where: \.needsYou), working: hidden.contains(where: \.working))
            }
            .fixedSize()
            .padding(.horizontal, 12)
            .frame(width: Self.chip, height: 36)
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
            Image(systemName: "progress.indicator")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.silver)
                .symbolEffect(.variableColor.iterative, options: .repeating)
        }
    }

    private func select(_ name: String) {
        withAnimation(.spring(duration: 0.35, bounce: 0.2)) { choose(name) }
    }
}
