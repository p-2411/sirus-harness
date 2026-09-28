import SwiftUI

// Command feedback, or why a message did not go, shown a moment over the
// composer.
struct Note: Equatable {
    let text: String
    let failed: Bool
}

// The input bar, drawn on the glass the conversation gives it. While the
// agent works, an empty draft turns send into stop; a message typed then is
// queued or steers, as in the terminal.
struct Composer: View {
    let client: RemoteClient
    let sessionId: String
    let participant: String
    let working: Bool
    @Binding var draft: String
    @Binding var note: Note?
    @State private var sending = false
    @State private var sent = 0
    @State private var stopped = 0
    @FocusState private var focused: Bool

    private var text: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var empty: Bool { text.isEmpty }
    private var stops: Bool { working && empty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 4) {
            TextField("", text: $draft, prompt: Text("Message \(participant)").foregroundStyle(Palette.subtle), axis: .vertical)
                .font(.body)
                .foregroundStyle(Palette.white)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.leading, 18)
                .padding(.vertical, 11)
            Button { if stops { stop() } else { send() } } label: { trailing }
            .buttonStyle(.plain)
            .disabled(!stops && (empty || sending))
            .accessibilityLabel(stops ? "Stop" : "Send")
            .padding(.trailing, 1)
        }
        .animation(.spring(duration: 0.3, bounce: 0.2), value: stops)
        .animation(.easeOut(duration: 0.15), value: empty)
        .sensoryFeedback(.impact(weight: .light), trigger: sent)
        .sensoryFeedback(.impact(weight: .medium), trigger: stopped)
        #if DEBUG
        .task {
            // Screenshot hooks: -composerDraft <text> and -composerFocused YES.
            if let preset = UserDefaults.standard.string(forKey: "composerDraft") { draft = preset }
            focused = UserDefaults.standard.bool(forKey: "composerFocused")
        }
        #endif
    }

    // Send, turning into an amber stop while the agent works.
    private var trailing: some View {
        Image(systemName: stops ? "stop.fill" : "arrow.up")
            .font(.system(size: stops ? 13 : 16, weight: .bold))
            .contentTransition(.symbolEffect(.replace))
            .foregroundStyle(stops || !empty ? Palette.ground : Palette.subtle)
            .frame(width: 34, height: 34)
            .background(Circle().fill(stops ? Palette.platinum : empty ? Color.white.opacity(0.08) : Palette.platinum))
            .frame(width: 44, height: 44)
            .contentShape(Circle())
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

    private func show(_ text: String, failed: Bool) {
        let shown = Note(text: text, failed: failed)
        note = shown
        Task {
            try? await Task.sleep(for: .seconds(failed ? 6 : 8))
            if note == shown { note = nil }
        }
    }
}
