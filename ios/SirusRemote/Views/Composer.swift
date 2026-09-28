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
    let onFocus: (Bool) -> Void
    let send: (String) async throws -> Void
    // Shows a note, or with nil puts the last one away.
    let notify: (Note?) -> Void
    @State private var sending = false
    @State private var sent = 0
    @State private var stopped = 0
    @FocusState private var focused: Bool

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
                .focused($focused)
                .padding(.leading, 18)
                .padding(.vertical, 11)
            Button { if stops { stop() } else { submit() } } label: { trailing }
            .buttonStyle(.plain)
            .disabled(!stops && (empty || sending))
            .accessibilityLabel(sending ? "Sending" : stops ? "Stop" : "Send")
            .padding(.trailing, 1)
        }
        .animation(.spring(duration: 0.3, bounce: 0.2), value: stops)
        .animation(.easeOut(duration: 0.15), value: empty)
        .sensoryFeedback(.impact(weight: .light), trigger: sent)
        .sensoryFeedback(.impact(weight: .medium), trigger: stopped)
        .onChange(of: focused) { _, now in onFocus(now) }
        #if DEBUG
        .task {
            // Screenshot hooks: -composerDraft <text> and -composerFocused YES.
            let preset = UserDefaults.standard.string(forKey: "composerDraft")
            if let preset { draft = preset }
            focused = UserDefaults.standard.bool(forKey: "composerFocused")
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
        draft = ""
        notify(nil)
        Task {
            defer { sending = false }
            do {
                try await send(message)
            } catch {
                if draft.isEmpty { draft = message }
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
