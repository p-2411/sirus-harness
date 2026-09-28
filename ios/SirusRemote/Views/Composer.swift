import SwiftUI

// The input bar, drawn on the glass the conversation gives it. While the
// agent works, an empty draft turns send into stop; a message typed then is
// queued or steers, as in the terminal. The conversation sends what it is
// given, so a picker it opens lands where the conversation keeps them, and
// shows the notes.
struct Composer: View {
    let client: RemoteClient
    let sessionId: String
    let participant: String
    let working: Bool
    @Binding var draft: String
    @Binding var selection: TextSelection?
    // Whether the composer has the keyboard, owned by the conversation,
    // which shows the `/` and `@` menu while it does.
    let focus: FocusState<Bool>.Binding
    let send: (String) async throws -> Void
    // Shows a note, or with nil puts the last one away.
    let notify: (Note?) -> Void
    @State private var sending = false
    @State private var sent = 0
    @State private var stopped = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if DEBUG
    // Where the composer is on screen, for the screenshot hook to find its
    // text view by.
    @State private var place: CGRect = .zero
    #endif

    private var text: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var empty: Bool { text.isEmpty }
    // Stop only once a message has gone: sending empties the draft, and a
    // second tap then must not cancel the turn it was meant to reach.
    private var stops: Bool { working && empty && !sending }

    var body: some View {
        HStack(alignment: .bottom, spacing: 4) {
            TextField("", text: $draft, selection: $selection,
                      prompt: Text("Message \(participant)").foregroundStyle(Palette.subtle), axis: .vertical)
                .font(.body)
                .foregroundStyle(Palette.white)
                .lineLimit(1...6)
                .focused(focus)
                .padding(.leading, 18)
                .padding(.vertical, 11)
            Button { if stops { stop() } else { submit() } } label: { trailing }
            .buttonStyle(.plain)
            .disabled(!stops && (empty || sending))
            .accessibilityLabel(sending ? "Sending" : stops ? "Stop" : "Send")
            .padding(.trailing, 1)
        }
        // Send turning into stop springs; lighting up, and turning to the
        // spinner and back once a message has gone, fade.
        .animation(Motion(reduced: reduceMotion).snap, value: stops)
        .animation(Motion.fade, value: empty)
        .animation(Motion.fade, value: sending)
        .sensoryFeedback(.impact(weight: .light), trigger: sent)
        .sensoryFeedback(.impact(weight: .medium), trigger: stopped)
        #if DEBUG
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { place = $0 }
        .task {
            // Screenshot hooks: -composerDraft <text> and -composerFocused YES.
            // The field takes the keyboard as a tap gives it: its own text
            // view becomes first responder, and the focus state hears of it
            // from there. While the screen is still settling after launch
            // the state can miss it, which no tap would meet, so it asks
            // again until the state has it.
            let preset = UserDefaults.standard.string(forKey: "composerDraft")
            if let preset { draft = preset }
            if UserDefaults.standard.bool(forKey: "composerFocused") {
                for _ in 0..<6 {
                    try? await Task.sleep(for: .milliseconds(700))
                    if focus.wrappedValue { break }
                    let field = textInput(within: place)
                    field?.resignFirstResponder()
                    field?.becomeFirstResponder()
                }
            }
            if preset != nil {
                await Task.yield()
                selection = TextSelection(range: draft.endIndex..<draft.endIndex)
            }
        }
        #endif
    }

    // Send, turning into a stop while the agent works; faint while there is
    // nothing to send, and turning while a message is on its way.
    private var trailing: some View {
        let lit = stops || !empty || sending
        return Group {
            if sending {
                ProgressView().controlSize(.small).tint(Palette.ground)
            } else {
                Image(systemName: stops ? "stop.fill" : "arrow.up")
                    .font(.system(size: stops ? 13 : 16, weight: .bold))
                    .contentTransition(.symbolEffect(.replace))
            }
        }
        .foregroundStyle(lit ? Palette.ground : Palette.subtle)
        .frame(width: 34, height: 34)
        .background(Circle().fill(lit ? Palette.platinum : Palette.fill))
        .frame(width: 44, height: 44)
        .contentShape(Circle())
    }

    private func submit() {
        let message = text
        guard !message.isEmpty, !sending else { return }
        sending = true
        sent += 1
        // A selection kept from the sent text would point past the new one.
        draft = ""
        selection = nil
        notify(nil)
        Task {
            defer { sending = false }
            do {
                try await send(message)
            } catch {
                if draft.isEmpty {
                    draft = message
                    selection = TextSelection(range: draft.endIndex..<draft.endIndex)
                }
                notify(Note(text: error.localizedDescription, failed: true))
            }
        }
    }

    private func stop() {
        stopped += 1
        Task {
            do { try await client.cancel(sessionId: sessionId) }
            catch { notify(Note(text: error.localizedDescription, failed: true)) }
        }
    }
}

#if DEBUG
// The text view whose middle lies within a place on screen: the composer's
// own, given the composer's place, whatever other fields the screen has.
@MainActor private func textInput(within place: CGRect) -> UIView? {
    let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
    var inputs: [UIView] = []
    func collect(_ view: UIView) {
        if view is UITextView || view is UITextField { inputs.append(view) }
        view.subviews.forEach(collect)
    }
    if let window { collect(window) }
    return inputs.first {
        let frame = $0.convert($0.bounds, to: nil)
        return place.contains(CGPoint(x: frame.midX, y: frame.midY))
    }
}
#endif
