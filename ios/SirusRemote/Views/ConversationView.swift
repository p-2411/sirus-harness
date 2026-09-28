import SwiftUI

// One participant's conversation in a session, laid out as the TUI lays it
// out: agent tabs on top, the transcript, the live status line, and the
// input bar, which an approval takes the place of. The chrome floats
// over the transcript in glass, and the transcript scrolls under it.
struct ConversationView: View {
    let store: RemoteStore
    let sessionId: String

    var body: some View {
        if let client = store.client(for: sessionId), let session = store.session(sessionId) {
            Conversation(store: store, client: client, session: session, participant: store.participant(for: sessionId))
        } else {
            VStack(spacing: 8) {
                Text(store.link == .live ? "This session is no longer remote controlled." : "Reconnecting to Sirus…")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Palette.text)
                if store.link == .live {
                    Text("Run `/rc` in it on your Mac to bring it back.")
                        .font(.system(size: 14))
                        .foregroundStyle(Palette.muted)
                }
            }
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct Conversation: View {
    let store: RemoteStore
    let client: RemoteClient
    let session: RemoteSession
    let participant: String
    // Kept here rather than in the composer, so a request that takes the
    // composer's place leaves the draft waiting, as the TUI does.
    @State private var draft = ""
    @State private var note: Note?
    @State private var selection: TextSelection?
    @State private var composerFocused = false
    @State private var completions: [CompletionItem] = []
    @State private var completionTask: Task<Void, Never>?
    @State private var completionGeneration = 0
    @State private var picker: CommandPicker?
    @State private var pickerRevision = 0
    @State private var chosenCompletion = 0
    @Namespace private var glass

    private var header: Header? { client.header }
    private var names: Set<String> { Set(header?.participants.map(\.name) ?? [participant]) }
    private var working: Bool {
        header?.participants.first { $0.name == participant }?.working ?? false
    }
    private var status: Status? { header?.status.flatMap { $0.participant == participant ? $0 : nil } }
    private var waitingQuestion: Request? {
        client.requests.first?.kind == .question ? client.requests.first : nil
    }

    var body: some View {
        Transcript(rows: client.rows, names: names, loading: header == nil)
            .safeAreaBar(edge: .top) {
                VStack(spacing: 8) {
                    Text(session.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.white)
                        .lineLimit(1)
                        .frame(height: 20)
                    if let participants = header?.participants, !participants.isEmpty {
                        AgentTabs(participants: participants, selected: participant) { name in
                            store.choose(name, in: session.id)
                        }
                    }
                }
                // The same inset on both sides, so the title and tabs centre
                // on the screen rather than on the space beside the rail.
                .padding(.horizontal, Sidebar.gutter)
                .padding(.bottom, 6)
                .background { Fade(edge: .top) }
            }
            .safeAreaBar(edge: .bottom) { bottom.background { Fade(edge: .bottom) } }
            .task(id: "\(client.endpoint.port)/\(session.id)/\(participant)/\(client.link == .live)") {
                // Before the socket is up this fails quietly; the client
                // subscribes again as soon as it is.
                try? await client.subscribe(sessionId: session.id, participant: participant)
            }
            .onChange(of: draft) { _, _ in updateCompletions() }
            .onChange(of: selection) { _, _ in updateCompletions() }
            .onChange(of: composerFocused) { _, _ in updateCompletions() }
            .onChange(of: client.requests.first?.id) { _, _ in updateCompletions() }
            .onChange(of: picker?.title) { _, _ in updateCompletions() }
            .onChange(of: participant) { _, _ in updateCompletions() }
            .onChange(of: session.id) { _, _ in updateCompletions() }
            .onChange(of: client.link) { _, _ in updateCompletions() }
    }

    // What floats at the bottom: the live status, feedback on the last
    // message, then the composer or the request standing in its place, and
    // under it the permission mode and model.
    private var bottom: some View {
        GlassEffectContainer(spacing: 8) {
            // Centred: the status and notes above the full-width composer.
            VStack(alignment: .center, spacing: 10) {
                if let question = waitingQuestion {
                    RequestCard(request: question, waiting: client.requests.count - 1, client: client, names: names)
                        .id(question.id)
                        .glassEffect(.regular, in: .rect(cornerRadius: 30, style: .continuous))
                        .glassEffectID("status", in: glass)
                } else if client.link != .live {
                    Pill(tone: Palette.muted) {
                        Image(systemName: client.link == .offline ? "wifi.slash" : "arrow.triangle.2.circlepath")
                            .symbolEffect(.rotate, isActive: client.link == .connecting)
                        Text(client.link == .offline ? "Offline" : "Reconnecting…")
                    }
                    .glassEffectID("status", in: glass)
                } else if working || status != nil {
                    StatusPill(status: status, queued: header?.queued ?? 0)
                        .glassEffectID("status", in: glass)
                }
                if let note {
                    Pill(tone: note.failed ? Palette.red : Palette.muted) {
                        Image(systemName: note.failed ? "exclamationmark.circle" : "checkmark.circle")
                        Text(note.text).font(.system(size: 13)).lineLimit(3)
                    }
                    .glassEffectID("note", in: glass)
                }
                if !completions.isEmpty && composerFocused && picker == nil &&
                    (client.requests.first == nil || client.requests.first?.kind == .question) {
                    CompletionMenu(items: completions, choose: chooseCompletion)
                        .padding(.leading, Sidebar.gutter - 12)
                }
                if let request = client.requests.first, request.kind != .question {
                    RequestCard(request: request, waiting: client.requests.count - 1, client: client, names: names)
                        .id(request.id)
                        .glassEffect(.regular,
                                     in: .rect(cornerRadius: 30, style: .continuous))
                        .glassEffectID("input", in: glass)
                } else if let picker {
                    PickerCard(picker: picker, dismiss: { self.picker = nil }, send: sendCommand)
                        .id(pickerRevision)
                        .glassEffect(.regular, in: .rect(cornerRadius: 30, style: .continuous))
                        .glassEffectID("input", in: glass)
                } else {
                    Composer(client: client, sessionId: session.id, participant: participant, working: working,
                             draft: $draft, note: $note, selection: $selection,
                             onFocus: { composerFocused = $0 }, onResult: receive)
                        .glassEffect(.regular, in: .rect(cornerRadius: 23, style: .continuous))
                        .glassEffectID("input", in: glass)
                }
                ModeCaption(header: header, participant: participant, send: sendCommand)
            }
        }
        .padding(.horizontal, 12)
        .animation(.spring(duration: 0.4, bounce: 0.14), value: client.requests.first?.id)
        .animation(.smooth(duration: 0.3), value: working || status != nil)
        .animation(.smooth(duration: 0.3), value: client.link)
        .animation(.smooth(duration: 0.25), value: note)
        .animation(.spring(duration: 0.4, bounce: 0.14), value: picker?.title)
        .sensoryFeedback(.impact(weight: .medium), trigger: client.requests.first?.id) { _, new in new != nil }
        .sensoryFeedback(.impact(weight: .light), trigger: chosenCompletion)
    }

    private func updateCompletions() {
        completionGeneration += 1
        let generation = completionGeneration
        completionTask?.cancel()
        guard composerFocused, picker == nil,
              client.requests.first == nil || client.requests.first?.kind == .question,
              client.link == .live else {
            completions = []
            return
        }
        let text = draft
        // The field reports its cursor as an index into its own copy of the
        // text, which can run ahead of `draft` for a moment: a tap into an
        // empty field does. An index this draft does not have counts as its
        // end; measuring it against the draft anyway traps.
        let cursor: Int
        if case .selection(let range) = selection?.indices,
           let caret = String.Index(range.lowerBound, within: text.utf16) {
            cursor = text.utf16.distance(from: text.utf16.startIndex, to: caret)
        } else { cursor = text.utf16.count }
        completionTask = Task {
            try? await Task.sleep(for: .milliseconds(80))
            guard !Task.isCancelled else { return }
            let items = try? await client.complete(text, cursor: cursor, sessionId: session.id, participant: participant)
            guard !Task.isCancelled, generation == completionGeneration else { return }
            completions = items ?? []
        }
    }

    private func chooseCompletion(_ item: CompletionItem) {
        guard item.start >= 0, item.end >= item.start,
              let range = Range(NSRange(location: item.start, length: item.end - item.start), in: draft) else { return }
        let offset = item.start + item.insert.utf16.count
        draft.replaceSubrange(range, with: item.insert)
        let caret = String.Index(utf16Offset: offset, in: draft)
        selection = TextSelection(range: caret..<caret)
        chosenCompletion += 1
        updateCompletions()
    }

    private func sendCommand(_ command: String) {
        Task {
            do { receive(try await client.send(command, sessionId: session.id, participant: participant)) }
            catch { show(error.localizedDescription, failed: true) }
        }
    }

    private func receive(_ result: ResultFrame) {
        if result.picker != nil { pickerRevision += 1 }
        picker = result.picker
        if let restored = result.draft {
            draft = restored
            selection = TextSelection(range: draft.endIndex..<draft.endIndex)
        }
        if let feedback = result.feedback, !feedback.isEmpty { show(feedback, failed: false) }
    }

    private func show(_ text: String, failed: Bool) {
        let shown = Note(text: text, failed: failed)
        note = shown
        Task {
            try? await Task.sleep(for: .seconds(failed ? 6 : 8))
            if note == shown { note = nil }
        }
    }
}

// The ground drawn in behind floating chrome, so the transcript fades out
// under it rather than running into the text on it.
private struct Fade: View {
    let edge: VerticalEdge

    var body: some View {
        LinearGradient(stops: edge == .top
                       ? [.init(color: Palette.ground, location: 0), .init(color: Palette.ground.opacity(0.97), location: 0.8), .init(color: Palette.ground.opacity(0), location: 1)]
                       : [.init(color: Palette.ground.opacity(0), location: 0), .init(color: Palette.ground.opacity(0.8), location: 0.6), .init(color: Palette.ground, location: 1)],
                       startPoint: .top, endPoint: .bottom)
            .padding(edge == .top ? .bottom : .top, -28)
            .ignoresSafeArea()
            .allowsHitTesting(false)
    }
}

// A small glass capsule of mono text above the composer.
private struct Pill<Content: View>: View {
    let tone: Color
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 8) { content }
            .font(.mono(12))
            .foregroundStyle(tone)
            .padding(.horizontal, 14)
            .frame(minHeight: 34)
            .glassEffect(.regular, in: .capsule)
    }
}

// What the selected agent is doing now: its current thought and how long the
// turn has run, as the TUI's live status says it.
private struct StatusPill: View {
    let status: Status?
    let queued: Int

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Pill(tone: Palette.silver) {
                Image(systemName: "progress.indicator")
                    .font(.system(size: 13, weight: .semibold))
                    .symbolEffect(.variableColor.iterative, options: .repeating)
                Text(firstLine(status?.thought) ?? "Working")
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                if queued > 0 {
                    Text("\(queued) queued").foregroundStyle(Palette.subtle)
                }
                if let started = status?.startedAt {
                    Text(elapsed(since: started, now: context.date)).monospacedDigit()
                }
            }
        }
    }

    private func firstLine(_ text: String?) -> String? {
        let line = text?.split(whereSeparator: \.isNewline).first.map { $0.trimmingCharacters(in: .whitespaces) }
        return line?.isEmpty == false ? line.map { $0.replacingOccurrences(of: "**", with: "") } : nil
    }
}

// Under the input, as the TUI's status row: the permission mode on the left,
// with what the vendor made of it; the context gauge, model and thinking
// level on the right.
private struct ModeCaption: View {
    let header: Header?
    let participant: String
    let send: (String) -> Void

    var body: some View {
        HStack(spacing: 6) {
            if let mode = permissionMode(header?.permissionMode) {
                let notice = Text(header?.modeNotice.map { " · \($0)" } ?? "").foregroundStyle(Palette.subtle)
                Button { send("/permissions") } label: {
                    Text("\(Text(mode.name).foregroundStyle(mode.color))\(notice)")
                        .truncationMode(.tail)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(RowPress())
            }
            Spacer(minLength: 0)
            if let context = header?.context {
                Text(context.text).foregroundStyle(tone(context.tone))
            }
            if let model = header?.participants.first(where: { $0.name == participant })?.model {
                if header?.context != nil { Text("·").foregroundStyle(Palette.subtle) }
                Button { send("/model") } label: {
                    Text(model).foregroundStyle(Palette.subtle).lineLimit(1)
                        .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(RowPress())
                .layoutPriority(1)
            }
            if let thinking = header?.thinking {
                if header?.context != nil || header?.participants.first(where: { $0.name == participant })?.model != nil {
                    Text("·").foregroundStyle(Palette.subtle)
                }
                Button { send("/thinking") } label: {
                    Text(thinking).foregroundStyle(Palette.subtle).lineLimit(1)
                        .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(RowPress())
            }
        }
        .font(.mono(11))
        .lineLimit(1)
        .padding(.horizontal, 18)
        .padding(.bottom, 2)
    }

    private func tone(_ tone: Header.Gauge.Tone) -> Color {
        switch tone {
        case .subtle: Palette.subtle
        case .warning: Palette.amber
        case .danger: Palette.red
        }
    }
}
