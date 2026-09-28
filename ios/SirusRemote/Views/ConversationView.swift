import SwiftUI

// One participant's conversation in a session, laid out as the TUI lays it
// out: agent tabs on top, the transcript, the live status line, and the
// input bar, which a waiting request takes the place of.
struct ConversationView: View {
    let store: RemoteStore
    let sessionId: String

    private var client: RemoteClient? { store.client(for: sessionId) }
    private var participant: String { store.participant(for: sessionId) }

    var body: some View {
        Group {
            if let client, let session = store.session(sessionId) {
                Conversation(store: store, client: client, session: session, participant: participant)
            } else {
                VStack(spacing: 10) {
                    Text(store.link == .live ? "This session is no longer remote controlled." : "Reconnecting to Sirus…")
                        .font(.system(size: 15))
                        .foregroundStyle(Palette.muted)
                    if store.link == .live {
                        Text("Run `/rc` in it on your Mac to bring it back.")
                            .font(.system(size: 13))
                            .foregroundStyle(Palette.subtle)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sirusScreen()
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct Conversation: View {
    let store: RemoteStore
    let client: RemoteClient
    let session: RemoteSession
    let participant: String

    private var header: Header? { client.header }
    private var names: Set<String> { Set(header?.participants.map(\.name) ?? [participant]) }
    private var working: Bool {
        header?.participants.first { $0.name == participant }?.working ?? false
    }

    var body: some View {
        VStack(spacing: 0) {
            if let participants = header?.participants, !participants.isEmpty {
                AgentTabs(participants: participants, selected: participant) { name in
                    store.choose(name, in: session.id)
                }
            }
            Hairline()
            Transcript(rows: client.rows, names: names, loading: header == nil)
            Hairline()
            StatusLine(header: header, participant: participant, working: working)
            if let request = client.requests.first {
                RequestCard(request: request, waiting: client.requests.count - 1, client: client, names: names)
                    .id(request.id)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else {
                Composer(client: client, sessionId: session.id, participant: participant, working: working)
                    .transition(.opacity)
            }
            ModeLine(header: header, participant: participant)
        }
        .animation(.smooth(duration: 0.28), value: client.requests.first?.id)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 2) {
                    Text(session.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.white)
                        .lineLimit(1)
                    Text(session.directory)
                        .font(.mono(10))
                        .foregroundStyle(Palette.muted)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                .frame(maxWidth: 240)
            }
        }
        .task(id: "\(client.endpoint.port)/\(session.id)/\(participant)/\(client.link == .live)") {
            // Before the socket is up this fails quietly; the client
            // subscribes again as soon as it is.
            try? await client.subscribe(sessionId: session.id, participant: participant)
        }
    }
}

// The participants as the TUI header lists them: the selected one picked out,
// a working one breathing amber, one waiting on the user marked.
private struct AgentTabs: View {
    let participants: [Participant]
    let selected: String
    let choose: (String) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 22) {
                ForEach(participants) { agent in
                    let active = agent.name == selected
                    Button { choose(agent.name) } label: {
                        VStack(spacing: 9) {
                            HStack(spacing: 6) {
                                Text(agent.name)
                                    .font(.mono(13, active ? .semibold : .regular))
                                    .foregroundStyle(active ? Palette.white : Palette.muted)
                                if agent.needsYou {
                                    Text("!").font(.mono(13, .bold)).foregroundStyle(Palette.amber)
                                } else if agent.working {
                                    Pulse(color: Palette.amber, size: 5)
                                }
                            }
                            Rectangle()
                                .fill(active ? Palette.platinum : .clear)
                                .frame(height: 1.5)
                        }
                        .fixedSize()
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(active ? .isSelected : [])
                }
            }
            .padding(.horizontal, 22)
            .padding(.top, 10)
        }
        .scrollIndicators(.hidden)
        .sensoryFeedback(.selection, trigger: selected)
    }
}

// What the selected agent is doing now: its current thought and how long the
// turn has run, as the TUI's live status says it.
private struct StatusLine: View {
    let header: Header?
    let participant: String
    let working: Bool

    var body: some View {
        let status = header?.status.flatMap { $0.participant == participant ? $0 : nil }
        if working || status != nil {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack(spacing: 10) {
                    Pulse(color: Palette.amber)
                    Text(firstLine(status?.thought) ?? "Working")
                        .foregroundStyle(Palette.silver)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 8)
                    if let queued = header?.queued, queued > 0 {
                        Text("\(queued) queued").foregroundStyle(Palette.subtle)
                    }
                    if let started = status?.startedAt {
                        Text(elapsed(since: started, now: context.date))
                            .foregroundStyle(Palette.amber)
                            .monospacedDigit()
                    }
                }
                .font(.mono(12))
                .padding(.horizontal, 22)
                .padding(.vertical, 10)
            }
            .transition(.opacity)
        }
    }

    private func firstLine(_ text: String?) -> String? {
        let line = text?.split(whereSeparator: \.isNewline).first.map { $0.trimmingCharacters(in: .whitespaces) }
        return line?.isEmpty == false ? line.map { $0.replacingOccurrences(of: "**", with: "") } : nil
    }
}

// The line under the input, as the TUI's status row: the permission mode on
// the left, the selected agent's model on the right.
private struct ModeLine: View {
    let header: Header?
    let participant: String

    var body: some View {
        HStack {
            if let mode = permissionMode(header?.permissionMode) {
                Text(mode.name).foregroundStyle(mode.color)
            }
            Spacer()
            if let model = header?.participants.first(where: { $0.name == participant })?.model {
                Text(model).foregroundStyle(Palette.subtle)
            }
        }
        .font(.mono(11))
        .lineLimit(1)
        .padding(.horizontal, 22)
        .padding(.top, 2)
        .padding(.bottom, 6)
    }
}

// The input bar. While the agent works, an empty draft offers stop in the
// send button's place; a message typed then is queued or steers, as in the
// terminal.
private struct Composer: View {
    let client: RemoteClient
    let sessionId: String
    let participant: String
    let working: Bool
    @State private var draft = ""
    @State private var sending = false
    @State private var note: (text: String, failed: Bool)?
    @State private var sent = 0
    @State private var stopped = 0
    @FocusState private var focused: Bool

    private var text: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let note {
                Text(note.text)
                    .font(.system(size: 13))
                    .foregroundStyle(note.failed ? Palette.red : Palette.muted)
                    .padding(.horizontal, 22)
                    .padding(.top, 10)
                    .transition(.opacity)
            }
            HStack(alignment: .bottom, spacing: 12) {
                TextField("", text: $draft, prompt: Text("Message \(participant)").foregroundStyle(Palette.subtle), axis: .vertical)
                    .font(.system(size: 16))
                    .foregroundStyle(Palette.white)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.vertical, 9)
                if working && text.isEmpty {
                    Button(action: stop) {
                        RoundedRectangle(cornerRadius: 2.5)
                            .fill(Palette.amber)
                            .frame(width: 11, height: 11)
                            .frame(width: 34, height: 34)
                            .overlay(Circle().strokeBorder(Palette.amber.opacity(0.7), lineWidth: 1))
                    }
                    .accessibilityLabel("Stop")
                    .sensoryFeedback(.impact(weight: .medium), trigger: stopped)
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(text.isEmpty ? Palette.subtle : Palette.ground)
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(text.isEmpty ? Palette.line.opacity(0.5) : Palette.platinum))
                    }
                    .disabled(text.isEmpty || sending)
                    .accessibilityLabel("Send")
                    .sensoryFeedback(.impact(weight: .light), trigger: sent)
                }
            }
            .padding(.leading, 22)
            .padding(.trailing, 14)
            .padding(.vertical, 8)
        }
        .animation(.easeOut(duration: 0.18), value: working && text.isEmpty)
        .animation(.easeOut(duration: 0.2), value: note?.text)
    }

    private func send() {
        let message = text
        guard !message.isEmpty, !sending else { return }
        sending = true
        sent += 1
        draft = ""
        note = nil
        Task {
            defer { sending = false }
            do {
                if let feedback = try await client.send(message, sessionId: sessionId, participant: participant), !feedback.isEmpty {
                    show(feedback, failed: false)
                }
            } catch {
                if draft.isEmpty { draft = message }
                show(error.localizedDescription, failed: true)
            }
        }
    }

    private func stop() {
        stopped += 1
        Task {
            do { try await client.cancel(sessionId: sessionId) } catch { show(error.localizedDescription, failed: true) }
        }
    }

    // Command feedback and failures stay a moment under the transcript.
    private func show(_ text: String, failed: Bool) {
        note = (text, failed)
        Task {
            try? await Task.sleep(for: .seconds(failed ? 6 : 8))
            if note?.text == text { note = nil }
        }
    }
}
