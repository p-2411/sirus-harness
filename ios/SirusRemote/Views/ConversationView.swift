import SwiftUI

// One participant's conversation in a session, laid out as the TUI lays it
// out: agent tabs on top, the transcript, the live status line, and the
// input bar, which an approval takes the place of. The chrome floats
// over the transcript in glass, and the transcript scrolls under it.
struct ConversationView: View {
    let store: RemoteStore
    let sessionId: String
    // Whether a menu is up over the conversation, so the sidebar's rail can
    // step aside for it.
    @Binding var menuOpen: Bool

    var body: some View {
        if let client = store.client(for: sessionId), let session = store.session(sessionId) {
            Conversation(store: store, client: client, session: session,
                         participant: store.participant(for: sessionId), menuOpen: $menuOpen)
        } else {
            VStack(spacing: 10) {
                Image(systemName: store.link == .live ? "antenna.radiowaves.left.and.right.slash" : "arrow.triangle.2.circlepath")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(Palette.subtle)
                    .symbolEffect(.rotate, isActive: store.link != .live)
                    .padding(.bottom, 4)
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
    @Binding var menuOpen: Bool
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
    // The caption's command whose picker is on its way.
    @State private var opening: String?
    // Where the chrome ends, so the menus can float just above the input
    // and clear of the header without being laid out in either bar: a menu
    // in a bar would grow it and push the transcript up.
    @State private var headerHeight: CGFloat = 0
    @State private var inputHeight: CGFloat = 0
    @State private var barHeight: CGFloat = 0
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
    // An approval stands in the composer's place until it is answered.
    private var approvalWaiting: Bool {
        client.requests.first.map { $0.kind != .question } ?? false
    }
    private var showsCompletions: Bool {
        !completions.isEmpty && composerFocused && picker == nil && !approvalWaiting
    }
    private var showsMenu: Bool { picker != nil || showsCompletions }
    private var showsStatus: Bool {
        waitingQuestion != nil || client.link != .live || working || status != nil
    }

    var body: some View {
        Transcript(rows: client.rows, names: names, loading: header == nil)
            .safeAreaBar(edge: .top) { top }
            .safeAreaBar(edge: .bottom) { bottom.background { Fade(edge: .bottom) } }
            .overlay { floating }
            .task(id: "\(client.endpoint.port)/\(session.id)/\(participant)/\(client.link == .live)") {
                // Before the socket is up this fails quietly; the client
                // subscribes again as soon as it is.
                try? await client.subscribe(sessionId: session.id, participant: participant)
            }
            .onChange(of: draft) { _, _ in updateCompletions() }
            .onChange(of: selection) { _, _ in updateCompletions() }
            .onChange(of: composerFocused) { _, _ in updateCompletions() }
            .onChange(of: client.requests.first?.id) { _, request in
                // A request needs the user more than a menu does.
                if request != nil { picker = nil }
                updateCompletions()
            }
            .onChange(of: picker?.title) { _, _ in updateCompletions() }
            .onChange(of: participant) { _, _ in
                // A picker belongs to the agent it was opened for.
                picker = nil
                updateCompletions()
            }
            .onChange(of: session.id) { _, _ in updateCompletions() }
            .onChange(of: client.link) { _, _ in updateCompletions() }
            .onChange(of: showsMenu, initial: true) { _, shown in menuOpen = shown }
            .onDisappear { menuOpen = false }
            .sensoryFeedback(.impact(weight: .medium), trigger: client.requests.first?.id) { _, new in new != nil }
            .sensoryFeedback(.impact(weight: .light), trigger: chosenCompletion)
    }

    // The session's name over its agents, centred on the screen.
    private var top: some View {
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
        // The same inset on both sides, so the title and tabs centre on the
        // screen rather than on the space beside the rail.
        .padding(.horizontal, Sidebar.gutter)
        .padding(.bottom, 6)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
        .background { Fade(edge: .top) }
    }

    // What the bar at the bottom holds: the live status, then the composer
    // or the approval standing in its place, and under it the permission
    // mode and model. Nothing else goes in it; see `floating`.
    private var bottom: some View {
        GlassEffectContainer(spacing: 8) {
            VStack(spacing: 10) {
                if showsStatus {
                    statusLine
                        // A menu floats where the status stands. Hidden rather
                        // than removed, so the bar keeps its height and the
                        // transcript stays where it is.
                        .opacity(showsMenu ? 0 : 1)
                        .allowsHitTesting(!showsMenu)
                }
                VStack(spacing: 0) {
                    input
                    ModeCaption(header: header, participant: participant, opening: opening, open: openPicker)
                }
                // A picker floats in the input's place, as the TUI's menu
                // takes the input bar's.
                .opacity(picker == nil ? 1 : 0)
                .allowsHitTesting(picker == nil)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { inputHeight = $0 }
            }
        }
        .padding(.horizontal, 12)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { barHeight = $0 }
        .animation(.spring(duration: 0.4, bounce: 0.14), value: client.requests.first?.id)
        .animation(.smooth(duration: 0.3), value: working || status != nil)
        .animation(.smooth(duration: 0.3), value: client.link)
        .animation(.smooth(duration: 0.2), value: showsMenu)
    }

    // A question grows out of the status line; otherwise it says whether
    // Sirus can be reached, and what the agent is doing.
    @ViewBuilder private var statusLine: some View {
        if let question = waitingQuestion {
            RequestCard(request: question, waiting: client.requests.count - 1, client: client, names: names)
                .id(question.id)
                .glassEffect(.regular, in: .rect(cornerRadius: 30, style: .continuous))
                .glassEffectID("status", in: glass)
        } else if client.link != .live {
            Button { if client.link == .offline { client.start() } } label: {
                Pill(tone: Palette.muted) {
                    Image(systemName: client.link == .offline ? "wifi.slash" : "arrow.triangle.2.circlepath")
                        .symbolEffect(.rotate, isActive: client.link == .connecting)
                    Text(client.link == .offline ? "Offline" : "Reconnecting…")
                    if client.link == .offline {
                        Text("Retry").foregroundStyle(Palette.platinum)
                    }
                }
            }
            .buttonStyle(RowPress())
            .disabled(client.link != .offline)
            .accessibilityHint("Reconnects to Sirus")
            .glassEffectID("status", in: glass)
        } else {
            StatusPill(status: status, queued: header?.queued ?? 0)
                .glassEffectID("status", in: glass)
        }
    }

    @ViewBuilder private var input: some View {
        if let request = client.requests.first, request.kind != .question {
            RequestCard(request: request, waiting: client.requests.count - 1, client: client, names: names)
                .id(request.id)
                .glassEffect(.regular, in: .rect(cornerRadius: 30, style: .continuous))
                .glassEffectID("input", in: glass)
        } else {
            Composer(client: client, sessionId: session.id, participant: participant, working: working,
                     draft: $draft, note: $note, selection: $selection,
                     onFocus: { composerFocused = $0 }, onResult: receive)
                .glassEffect(.regular, in: .rect(cornerRadius: 23, style: .continuous))
                .glassEffectID("input", in: glass)
        }
    }

    // What floats over the conversation without being laid out in it: a
    // command's picker in the input's place, over a scrim that closes it;
    // the `/` and `@` completions just above the input; and a note on the
    // last command above the whole bar.
    private var floating: some View {
        ZStack(alignment: .bottom) {
            if picker != nil {
                Color.black.opacity(0.32)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { closePicker() }
                    .accessibilityLabel("Close Menu")
                    .accessibilityAddTraits(.isButton)
                    .transition(.opacity)
            }
            if let note, !showsMenu {
                NoteToast(note: note) { self.note = nil }
                    .padding(.horizontal, 24)
                    .padding(.bottom, barHeight + 10)
                    .transition(.opacity.combined(with: .offset(y: 6)))
            }
            if let picker {
                PickerCard(picker: picker, dismiss: closePicker, send: run)
                    .id(pickerRevision)
                    .padding(.horizontal, 12)
                    .padding(.top, headerHeight + 12)
                    .transition(.menu)
            } else if showsCompletions {
                CompletionMenu(items: completions, choose: chooseCompletion)
                    .padding(.horizontal, 12)
                    .padding(.top, headerHeight + 12)
                    .padding(.bottom, inputHeight + 8)
                    .transition(.menu)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .animation(.spring(duration: 0.35, bounce: 0.1), value: picker == nil)
        .animation(.spring(duration: 0.35, bounce: 0.1), value: pickerRevision)
        .animation(.smooth(duration: 0.2), value: showsCompletions)
        .animation(.smooth(duration: 0.25), value: note)
    }

    private func updateCompletions() {
        completionGeneration += 1
        let generation = completionGeneration
        completionTask?.cancel()
        guard composerFocused, picker == nil, !approvalWaiting, client.link == .live else {
            completions = []
            return
        }
        let text = draft
        let cursor: Int
        if case .selection(let range) = selection?.indices {
            cursor = max(0, min(range.lowerBound.utf16Offset(in: text), text.utf16.count))
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

    // A tap on the caption: its command opens a picker rather than running.
    private func openPicker(_ command: String) {
        guard opening == nil else { return }
        opening = command
        Task {
            await run(command)
            opening = nil
        }
    }

    private func closePicker() {
        picker = nil
    }

    private func run(_ command: String) async {
        do { receive(try await client.send(command, sessionId: session.id, participant: participant)) }
        catch { show(error.localizedDescription, failed: true) }
    }

    private func receive(_ result: ResultFrame) {
        if result.picker != nil {
            pickerRevision += 1
            // The picker wants the room the keyboard takes.
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
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
            try? await Task.sleep(for: .seconds(Note.duration(failed: failed)))
            if note == shown { note = nil }
        }
    }
}

private extension AnyTransition {
    // A menu grows out of what it belongs to, below it.
    static var menu: AnyTransition {
        .scale(scale: 0.94, anchor: .bottom).combined(with: .opacity)
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

// What a command said, a moment over the conversation. A tap puts it away.
private struct NoteToast: View {
    let note: Note
    let dismiss: () -> Void

    var body: some View {
        Button(action: dismiss) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: note.failed ? "exclamationmark.circle.fill" : "checkmark.circle")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(note.failed ? Palette.red : Palette.muted)
                Text(note.text)
                    .font(.system(size: 14))
                    .foregroundStyle(Palette.text)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
            .frame(minHeight: 38)
            .glassEffect(.regular, in: .rect(cornerRadius: 19, style: .continuous))
        }
        .buttonStyle(RowPress())
        .accessibilityHint("Dismisses the message")
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
// level on the right. The mode, model and thinking level are controls, each
// opening its command's picker.
private struct ModeCaption: View {
    let header: Header?
    let participant: String
    let opening: String?
    let open: (String) -> Void

    private var model: String? { header?.participants.first { $0.name == participant }?.model }

    var body: some View {
        HStack(spacing: 6) {
            if let mode = permissionMode(header?.permissionMode) {
                let notice = Text(header?.modeNotice.map { " · \($0)" } ?? "").foregroundStyle(Palette.subtle)
                CaptionChip(name: "Permission mode", value: mode.name, busy: opening == "/permissions") {
                    open("/permissions")
                } label: {
                    Text("\(Text(mode.name).foregroundStyle(mode.color))\(notice)")
                }
            }
            Spacer(minLength: 4)
            if let context = header?.context {
                Text(context.text)
                    .foregroundStyle(tone(context.tone))
                    .padding(.trailing, 2)
            }
            if let model {
                CaptionChip(name: "Model", value: model, busy: opening == "/model") {
                    open("/model")
                } label: {
                    Text(model)
                }
                .layoutPriority(1)
            }
            if let thinking = header?.thinking {
                CaptionChip(name: "Thinking", value: thinking, busy: opening == "/thinking") {
                    open("/thinking")
                } label: {
                    Text(thinking)
                }
            }
        }
        .font(.mono(11))
        .lineLimit(1)
        .padding(.horizontal, 4)
        .sensoryFeedback(.selection, trigger: opening) { _, new in new != nil }
    }

    private func tone(_ tone: Header.Gauge.Tone) -> Color {
        switch tone {
        case .subtle: Palette.subtle
        case .warning: Palette.amber
        case .danger: Palette.red
        }
    }
}

// One setting on the caption, drawn as something to tap: a faint capsule
// with the up-and-down chevrons of a menu, which pulse while its picker is
// on its way. The whole row height takes the tap.
private struct CaptionChip<Content: View>: View {
    let name: String
    let value: String
    let busy: Bool
    let action: () -> Void
    @ViewBuilder let label: Content

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                label
                    .foregroundStyle(Palette.muted)
                    .truncationMode(.tail)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 7.5, weight: .bold))
                    .foregroundStyle(Palette.subtle)
                    .symbolEffect(.pulse, isActive: busy)
            }
            .padding(.horizontal, 10)
            .frame(height: 26)
            .background(Capsule().fill(.white.opacity(busy ? 0.11 : 0.06)))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPress())
        .accessibilityLabel(name)
        .accessibilityValue(value)
        .accessibilityHint("Opens a menu to change it")
    }
}
