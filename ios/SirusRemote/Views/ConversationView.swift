import SwiftUI
#if DEBUG
import os

// What the screenshot runs read back from the simulator's log.
private let screensLog = Logger(subsystem: "com.sirus.remote", category: "screens")
#endif

// One participant's conversation in a session, laid out as the TUI lays it
// out: agent tabs on top, the transcript, the live status line, and the
// input bar, which an approval takes the place of. The chrome floats
// over the transcript in glass, and the transcript scrolls under it.
struct ConversationView: View {
    let store: RemoteStore
    let sessionId: String
    // Whether a menu is up over the conversation, so the sidebar's rail can
    // step aside for it, and where the bottom bar starts, for the rail to
    // end above it.
    @Binding var menuOpen: Bool
    @Binding var chromeTop: CGFloat

    var body: some View {
        if let client = store.client(for: sessionId), let session = store.session(sessionId) {
            // Only what the conversation shows of the session is passed on,
            // so the list's activity updates don't redraw it.
            Conversation(store: store, client: client, sessionId: session.id, sessionName: session.name,
                         participant: store.participant(for: sessionId), menuOpen: $menuOpen, chromeTop: $chromeTop)
        } else if store.link == .live && !store.clients.contains(where: { $0.link == .connecting }) {
            // Every Sirus answered, and none has it.
            VStack(spacing: 10) {
                Image(systemName: "antenna.radiowaves.left.and.right.slash")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(Palette.subtle)
                    .padding(.bottom, 4)
                    .accessibilityHidden(true)
                Text("This session is no longer remote controlled.")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Palette.text)
                Text("Run `/rc` in it on your Mac to bring it back.")
                    .font(.system(size: 14))
                    .foregroundStyle(Palette.muted)
            }
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            // Still reaching the Mac, or unable to: the lobby says which,
            // and what to check.
            Lobby(store: store)
        }
    }
}

// What was said about the last thing sent, a moment over the conversation:
// long enough to read, then out of the way. A failure stays a little
// longer, and a long note longer still.
struct Note: Equatable {
    let text: String
    let failed: Bool

    var duration: Double { min(12, (failed ? 6 : 3.5) + Double(text.count) / 40) }
}

private struct Conversation: View {
    let store: RemoteStore
    let client: RemoteClient
    let sessionId: String
    let sessionName: String
    let participant: String
    @Binding var menuOpen: Bool
    @Binding var chromeTop: CGFloat
    // Kept here rather than in the composer, so an approval that takes the
    // composer's place leaves the draft waiting, as the TUI does.
    @State private var draft = ""
    @State private var note: Note?
    @State private var selection: TextSelection?
    // Owned here rather than reported up by the composer: a report of it
    // never arrived, so the menu never had a query.
    @FocusState private var composerFocused: Bool
    @State private var completions = Completions()
    @State private var picker: CommandPicker?
    @State private var pickerRevision = 0
    @State private var chosenCompletion = 0
    // The caption's command whose picker is on its way.
    @State private var openingCommand: String?
    // Bumped whenever a picker is put away or another agent is chosen. An
    // answer to something sent before that opens no picker; what it said is
    // still shown.
    @State private var pickerEpoch = 0
    // Where the chrome ends, so the menus can float just above the input
    // and clear of the header without being laid out in either bar: a menu
    // in a bar would grow it and push the transcript up.
    @State private var headerHeight: CGFloat = 0
    @State private var inputHeight: CGFloat = 0
    @State private var barHeight: CGFloat = 0
    @State private var floatingHeight: CGFloat = 0
    @Namespace private var glass

    // The `/` and `@` menu's rows, with the draft they were worked out for:
    // their offsets only fit that text.
    private struct Completions {
        var text = ""
        var items: [CompletionItem] = []
    }

    // What the menu is asked for, while the composer has the keyboard and a
    // `/` or `@` before the cursor could open it; nil otherwise.
    private struct CompletionQuery: Equatable {
        let text: String
        let cursor: Int
    }

    // Where a message or command came from, which decides what its answer
    // may do to the pickers.
    private enum Origin { case composer, caption, picker }

    private var header: Header? { client.header }
    private var names: Set<String> { Set(header?.participants.map(\.name) ?? [participant]) }
    private var working: Bool {
        header?.participants.first { $0.name == participant }?.working ?? false
    }
    private var status: Status? { header?.status.flatMap { $0.participant == participant ? $0 : nil } }
    private var waitingQuestion: Request? {
        client.requests.first.flatMap { $0.kind == .question ? $0 : nil }
    }
    // An approval stands in the composer's place until it is answered.
    private var waitingApproval: Request? {
        client.requests.first.flatMap { $0.kind == .question ? nil : $0 }
    }
    private var showsCompletions: Bool {
        !completions.items.isEmpty && composerFocused && picker == nil && waitingApproval == nil
    }
    private var showsMenu: Bool { picker != nil || showsCompletions }
    private var showsStatus: Bool {
        waitingQuestion != nil || client.link != .live || working || status != nil
    }

    private var completionQuery: CompletionQuery? {
        guard composerFocused, picker == nil, waitingApproval == nil, client.link == .live else { return nil }
        let cursor = caret
        let before = String(decoding: draft.utf16.prefix(cursor), as: UTF16.self)
        guard before.contains("/") || before.contains("@") else { return nil }
        return CompletionQuery(text: draft, cursor: cursor)
    }

    // The caret's place in the draft in UTF-16 units, as Sirus counts: the
    // selection's start when it lies in this draft, else the end. A
    // selection can briefly belong to the text before the last change, and
    // measuring the draft with its index would trap.
    private var caret: Int {
        let end = draft.utf16.count
        guard case .selection(let range)? = selection?.indices,
              range.lowerBound >= draft.startIndex, range.lowerBound <= draft.endIndex,
              let position = range.lowerBound.samePosition(in: draft.utf16) else { return end }
        return min(end, draft.utf16.distance(from: draft.utf16.startIndex, to: position))
    }

    var body: some View {
        Transcript(client: client, sessionId: sessionId, participant: participant, names: names)
            .safeAreaBar(edge: .top) { top }
            .safeAreaBar(edge: .bottom) { bottom.background { Fade(edge: .bottom) } }
            .overlay { floating }
            .task(id: "\(client.endpoint.port)/\(sessionId)/\(participant)") { await subscribe() }
            .task(id: completionQuery) {
                #if DEBUG
                let query = completionQuery.map { "\($0.text)@\($0.cursor)" } ?? "none"
                let line = "menu query \(query): focused \(composerFocused), picker \(picker != nil), approval \(waitingApproval != nil), live \(client.link == .live), draft \(draft), caret \(caret)"
                screensLog.notice("\(line, privacy: .public)")
                #endif
                await complete(completionQuery)
            }
            .onChange(of: client.requests.first?.id) { _, id in
                guard id != nil, let request = client.requests.first else { return }
                // A request needs the user more than a menu does, and
                // VoiceOver says it arrived wherever focus is.
                closePicker()
                let arrival = request.kind == .question ? "asks you something" : "needs your approval"
                let announcement: String = "\(request.requester) \(arrival)"
                AccessibilityNotification.Announcement(announcement).post()
            }
            .onChange(of: participant) { _, _ in
                // A picker belongs to the agent it was opened for.
                closePicker()
            }
            .onChange(of: showsMenu, initial: true) { _, shown in menuOpen = shown }
            .onDisappear {
                menuOpen = false
                chromeTop = .infinity
            }
            // Typed text outlives the screen: back in this session, it waits.
            .onAppear { if draft.isEmpty { draft = store.draft(for: sessionId) } }
            .onChange(of: draft) { _, text in store.keep(draft: text, for: sessionId) }
            #if DEBUG
            .task { await screenshotHooks() }
            #endif
            .sensoryFeedback(.impact(weight: .medium), trigger: client.requests.first?.id) { _, new in new != nil }
            .sensoryFeedback(.impact(weight: .light), trigger: chosenCompletion)
            .sensoryFeedback(.error, trigger: note) { _, new in new?.failed == true }
    }

    // The session's name over its agents, centred on the screen.
    private var top: some View {
        // The same inset on both sides, so the title and tabs centre on the
        // screen rather than on the space beside the rail; the tabs, a
        // capsule of their own, only need to keep clear of the rail.
        VStack(spacing: 8) {
            Text(sessionName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.white)
                .lineLimit(1)
                .frame(height: 20)
                .padding(.horizontal, Sidebar.gutter - Sidebar.clearance)
            if let participants = header?.participants, !participants.isEmpty {
                AgentTabs(participants: participants, selected: participant) { name in
                    store.choose(name, in: sessionId)
                }
            }
        }
        .padding(.horizontal, Sidebar.clearance)
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
                        // transcript stays where it is; its glass is turned
                        // off too, as the container draws glass itself, and
                        // its animations stop.
                        .opacity(showsMenu ? 0 : 1)
                        .allowsHitTesting(!showsMenu)
                        .symbolEffectsRemoved(showsMenu)
                }
                VStack(spacing: 0) {
                    input
                    ModeCaption(header: header, participant: participant, openingCommand: openingCommand, open: openPicker)
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
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { chromeTop = $0 }
        .animation(.spring(duration: 0.4, bounce: 0.14), value: client.requests.first?.id)
        .animation(.smooth(duration: 0.3), value: working || status != nil)
        .animation(.smooth(duration: 0.3), value: client.link)
        .animation(.smooth(duration: 0.2), value: showsMenu)
    }

    // A note goes above the bar, unless a picker takes the bottom or the
    // bar, with a question and the keyboard up, leaves too little room over
    // it; then it goes under the header.
    private var noteOnTop: Bool { picker != nil || barHeight > floatingHeight / 2 }

    // Glass for what a menu hides: none while it is hidden.
    private var statusGlass: Glass { showsMenu ? .identity : .regular }
    private var inputGlass: Glass { picker == nil ? .regular : .identity }

    // Whether Sirus can be reached, over a question that grows out of the
    // status line, or else what the agent is doing. The link stays in view
    // above a question, since answering needs it.
    private var statusLine: some View {
        VStack(spacing: 10) {
            if client.link != .live {
                Button {
                    // The same process back, or one restarted on another port.
                    client.start()
                    Task { await store.rescan() }
                } label: {
                    Pill(tone: Palette.muted, glass: statusGlass) {
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
                .glassEffectID("link", in: glass)
            }
            if let question = waitingQuestion {
                RequestCard(request: question, waiting: client.requests.count - 1, client: client, names: names)
                    .id(question.id)
                    .glassEffect(statusGlass, in: .rect(cornerRadius: 30, style: .continuous))
                    .glassEffectID("status", in: glass)
            } else if client.link == .live {
                StatusPill(status: status, queued: header?.queued ?? 0, glass: statusGlass)
                    .glassEffectID("status", in: glass)
            }
        }
    }

    @ViewBuilder private var input: some View {
        if let approval = waitingApproval {
            RequestCard(request: approval, waiting: client.requests.count - 1, client: client, names: names)
                .id(approval.id)
                .glassEffect(inputGlass, in: .rect(cornerRadius: 30, style: .continuous))
                .glassEffectID("input", in: glass)
        } else {
            Composer(client: client, sessionId: sessionId, participant: participant, working: working,
                     draft: $draft, selection: $selection,
                     focus: $composerFocused,
                     send: { try await send($0, from: .composer) },
                     notify: notify)
                .glassEffect(inputGlass, in: .rect(cornerRadius: 23, style: .continuous))
                .glassEffectID("input", in: glass)
        }
    }

    // What floats over the conversation without being laid out in it: a
    // command's picker in the input's place, over a scrim that closes it;
    // the `/` and `@` completions just above the input; and a note above the
    // whole bar, or under the header while a picker takes the bottom.
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
            if let note, !showsCompletions {
                NoteToast(note: note) { notify(nil) }
                    .padding(.horizontal, 24)
                    .padding(noteOnTop ? .top : .bottom, noteOnTop ? headerHeight + 10 : barHeight + 10)
                    .frame(minHeight: 0, maxHeight: .infinity, alignment: noteOnTop ? .top : .bottom)
                    .zIndex(1)
                    .transition(.opacity.combined(with: .offset(y: 6)))
            }
            if let picker {
                PickerCard(picker: picker, dismiss: closePicker, run: { try await send($0, from: .picker) })
                    .id(pickerRevision)
                    .padding(.horizontal, 12)
                    .padding(.top, headerHeight + 12)
                    .transition(.menu)
            } else if showsCompletions {
                CompletionMenu(items: completions.items, choose: chooseCompletion)
                    .padding(.horizontal, 12)
                    .padding(.top, headerHeight + 12)
                    .padding(.bottom, inputHeight + 8)
                    .transition(.menu)
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .bottom)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { floatingHeight = $0 }
        .animation(.spring(duration: 0.35, bounce: 0.1), value: picker == nil)
        .animation(.spring(duration: 0.35, bounce: 0.1), value: pickerRevision)
        .animation(.smooth(duration: 0.2), value: showsCompletions)
        .animation(.smooth(duration: 0.25), value: note)
    }

    // Before the socket is up this fails quietly: the client subscribes
    // again as soon as it is. A live Sirus that refuses, as for an agent it
    // doesn't have, says why, and the conversation falls back to its first
    // agent rather than waiting on one that won't come.
    private func subscribe() async {
        do {
            try await client.subscribe(sessionId: sessionId, participant: participant)
        } catch {
            guard !Task.isCancelled, client.link == .live else { return }
            show(error.localizedDescription, failed: true)
            let fallback = header?.participants.first?.name ?? "sirus"
            if fallback != participant { store.choose(fallback, in: sessionId) }
        }
    }

    // Asks for the menu after a short pause in typing; a newer query cancels
    // this one.
    private func complete(_ query: CompletionQuery?) async {
        guard let query else {
            completions = Completions()
            return
        }
        try? await Task.sleep(for: .milliseconds(80))
        guard !Task.isCancelled else { return }
        let items = try? await client.complete(query.text, cursor: query.cursor, sessionId: sessionId, participant: participant)
        #if DEBUG
        screensLog.notice("completions for \(query.text, privacy: .public) at \(query.cursor): \(items?.count ?? -1) rows, cancelled \(Task.isCancelled)")
        #endif
        guard !Task.isCancelled else { return }
        completions = Completions(text: query.text, items: items ?? [])
    }

    private func chooseCompletion(_ item: CompletionItem) {
        // Rows worked out for an older draft would land in the wrong place;
        // the menu for this one is on its way.
        guard draft == completions.text, item.start >= 0, item.end >= item.start,
              let range = Range(NSRange(location: item.start, length: item.end - item.start), in: draft) else { return }
        let offset = item.start + item.insert.utf16.count
        draft.replaceSubrange(range, with: item.insert)
        let after = String.Index(utf16Offset: offset, in: draft)
        selection = TextSelection(range: after..<after)
        chosenCompletion += 1
    }

    // A tap on the caption: its command opens a picker rather than running.
    // The chip lets go after a while even if Sirus never answers, so the
    // caption can't stay stuck.
    private func openPicker(_ command: String) {
        guard openingCommand == nil else { return }
        openingCommand = command
        Task {
            do { try await send(command, from: .caption) }
            catch { show(error.localizedDescription, failed: true) }
            if openingCommand == command { openingCommand = nil }
        }
        Task {
            try? await Task.sleep(for: .seconds(10))
            if openingCommand == command { openingCommand = nil }
        }
    }

    private func closePicker() {
        pickerEpoch += 1
        picker = nil
    }

    // Sends a message or command to the agent and applies what comes back:
    // a picker to open, text held back behind it, and what Sirus said. A
    // picker's entry that ran closes it. If a picker was put away or another
    // agent chosen meanwhile, no picker opens and held-back text only
    // returns to an empty composer. Failures are thrown to whoever sent,
    // except that a picker already gone can't show one, so it is shown here.
    private func send(_ text: String, from origin: Origin) async throws {
        let epoch = pickerEpoch
        let result: ResultFrame
        do {
            result = try await client.send(text, sessionId: sessionId, participant: participant)
        } catch {
            if origin == .picker, epoch != pickerEpoch { show(error.localizedDescription, failed: true) }
            throw error
        }
        let current = epoch == pickerEpoch
        if current, let next = result.picker {
            pickerRevision += 1
            picker = next
            // The picker wants the room the keyboard takes.
            dismissKeyboard()
        } else if current, origin == .picker {
            picker = nil
        }
        if let restored = result.draft, current || draft.isEmpty {
            draft = restored
            selection = TextSelection(range: draft.endIndex..<draft.endIndex)
        }
        if let feedback = result.feedback, !feedback.isEmpty { show(feedback, failed: false) }
    }

    private func show(_ text: String, failed: Bool) {
        notify(Note(text: text, failed: failed))
    }

    #if DEBUG
    // Screenshot hooks beside the composer's: -openPicker /model opens a
    // picker as a caption tap would, and -sendOnLaunch <text> sends a
    // message, once the conversation is live.
    private func screenshotHooks() async {
        let defaults = UserDefaults.standard
        let command = defaults.string(forKey: "openPicker"), message = defaults.string(forKey: "sendOnLaunch")
        guard command != nil || message != nil else { return }
        var waited = 0
        while (client.link != .live || header == nil) && waited < 100 {
            try? await Task.sleep(for: .milliseconds(100))
            waited += 1
        }
        if let command { openPicker(command) }
        if let message {
            do { try await send(message, from: .composer) } catch { show(error.localizedDescription, failed: true) }
        }
    }
    #endif

    // Shows a note until its time is up or another replaces it; nil puts
    // the current one away.
    private func notify(_ shown: Note?) {
        note = shown
        guard let shown else { return }
        // It appears away from where VoiceOver's focus is, so it is read out.
        AccessibilityNotification.Announcement(shown.text).post()
        Task {
            try? await Task.sleep(for: .seconds(shown.duration))
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
    var glass: Glass = .regular
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 8) { content }
            .font(.mono(12))
            .foregroundStyle(tone)
            .padding(.horizontal, 14)
            .frame(minHeight: 34)
            .glassEffect(glass, in: .capsule)
    }
}

// A note: what a command said, or why something sent did not go. A tap
// puts it away.
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
    var glass: Glass = .regular

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Pill(tone: Palette.silver, glass: glass) {
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
    let openingCommand: String?
    let open: (String) -> Void

    private var model: String? { header?.participants.first { $0.name == participant }?.model }

    // One line where it all fits. On a narrow screen, two: the permission
    // mode and the context over the model and thinking level, so none is
    // cut to a letter. The gauge drops its trailing parts before the mode
    // gives any room, since the mode says whether anything is asked; a
    // long model id gives way in the middle.
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                mode(height: 44)
                Spacer(minLength: 4)
                gauge(gaugeForms.first)
                agent(height: 44)
            }
            VStack(spacing: 0) {
                ViewThatFits(in: .horizontal) {
                    ForEach(gaugeForms, id: \.self) { form in
                        HStack(spacing: 6) {
                            mode(height: 36)
                            Spacer(minLength: 4)
                            gauge(form)
                        }
                    }
                    HStack(spacing: 6) {
                        mode(height: 36).layoutPriority(1)
                        Spacer(minLength: 4)
                        gauge(gaugeForms.last).fixedSize()
                    }
                }
                HStack(spacing: 6) {
                    Spacer(minLength: 0)
                    agent(height: 36)
                }
            }
        }
        .font(.mono(11))
        .lineLimit(1)
        .padding(.horizontal, 4)
        .sensoryFeedback(.selection, trigger: openingCommand) { _, new in new != nil }
    }

    @ViewBuilder private func mode(height: CGFloat) -> some View {
        if let mode = header?.permissionMode, !mode.isEmpty {
            let notice = Text(header?.modeNotice.map { " · \($0)" } ?? "").foregroundStyle(Palette.subtle)
            CaptionChip(name: "Permission mode", value: mode, busy: openingCommand == "/permissions", height: height) {
                open("/permissions")
            } label: {
                Text("\(Text(mode).foregroundStyle(permissionColor(mode)))\(notice)")
            }
        }
    }

    // The gauge as the TUI words it, then shorter by one " · " part at a
    // time: "ctx 184k · 8% left · /compact", "ctx 184k · 8% left", "ctx 184k".
    private var gaugeForms: [String] {
        guard let text = header?.context?.text, !text.isEmpty else { return [] }
        let parts = text.components(separatedBy: " · ")
        return (1...parts.count).reversed().map { parts.prefix($0).joined(separator: " · ") }
    }

    @ViewBuilder private func gauge(_ text: String?) -> some View {
        if let text, let context = header?.context {
            Text(text)
                .foregroundStyle(tone(context.tone))
                .padding(.trailing, 2)
        }
    }

    @ViewBuilder private func agent(height: CGFloat) -> some View {
        if let model {
            CaptionChip(name: "Model", value: model, busy: openingCommand == "/model", height: height, truncation: .middle) {
                open("/model")
            } label: {
                Text(model)
            }
        }
        if let thinking = header?.thinking {
            CaptionChip(name: "Thinking", value: thinking, busy: openingCommand == "/thinking", height: height) {
                open("/thinking")
            } label: {
                Text(thinking)
            }
        }
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
    // The row it sits in, all of which takes the tap.
    var height: CGFloat = 44
    var truncation: Text.TruncationMode = .tail
    let action: () -> Void
    @ViewBuilder let label: Content

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                label
                    .foregroundStyle(Palette.muted)
                    .truncationMode(truncation)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 7.5, weight: .bold))
                    .foregroundStyle(Palette.subtle)
                    .symbolEffect(.pulse, isActive: busy)
            }
            .padding(.horizontal, 10)
            .frame(height: 26)
            .background(Capsule().fill(.white.opacity(busy ? 0.11 : 0.06)))
            .frame(minHeight: height)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPress())
        .accessibilityLabel(name)
        .accessibilityValue(value)
        .accessibilityHint("Opens a menu to change it")
    }
}
