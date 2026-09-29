import SwiftUI

// A command's menu, floating over the conversation in the input's place.
// Entries and follow-up prompts come from the server, in the same order as
// the terminal's picker. An entry runs as soon as it is tapped, showing it
// is on its way until Sirus answers, and why it failed if it did; one that
// needs a value first opens a field under the list for it.
struct PickerCard: View {
    let picker: CommandPicker
    let dismiss: () -> Void
    // Runs an entry's command; what Sirus answers is the conversation's to
    // apply.
    let run: (String) async throws -> Void
    @State private var prompted: CommandPicker.Entry?
    @State private var value = ""
    @State private var busy: String?
    @State private var failure: String?
    @State private var contentHeight: CGFloat = 0
    @FocusState private var entryFocused: Bool

    // "/model" reads as "Model"; the command itself stays beside it.
    private var title: String {
        let name = picker.title.hasPrefix("/") ? String(picker.title.dropFirst()) : picker.title
        return name.prefix(1).uppercased() + name.dropFirst()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            list
            if let failure {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 12, weight: .semibold))
                    Text(failure)
                        .font(.system(size: 13))
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(Palette.red)
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .transition(.opacity)
            }
            if let prompted, let prompt = prompted.prompt {
                field(prompt, for: prompted)
            }
        }
        .padding(.bottom, 8)
        .glassEffect(.regular, in: .rect(cornerRadius: 30, style: .continuous))
        .animation(Motion.settle, value: prompted?.id)
        .animation(Motion.settle, value: failure)
        // An entry on its way turns to a spinner, and back, without a jump.
        .animation(Motion.fade, value: busy)
        .accessibilityAction(.escape, dismiss)
        // Over a scrim that closes it: VoiceOver stays inside until then.
        .accessibilityAddTraits(.isModal)
    }

    // The title, and a close button in the corner. A swipe down on it
    // closes the menu too.
    private var header: some View {
        HStack(spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Palette.white)
                if picker.title.hasPrefix("/") {
                    Text(picker.title)
                        .font(.mono(11))
                        .foregroundStyle(Palette.subtle)
                }
            }
            .lineLimit(1)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Palette.muted)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Palette.fill))
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(RowPress())
            .accessibilityLabel("Close")
        }
        .padding(.leading, 20)
        .padding(.trailing, 8)
        .padding(.top, 6)
        .padding(.bottom, 2)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 20).onEnded { if $0.translation.height > 50 { dismiss() } })
    }

    // As tall as the entries, up to a limit, and shorter still when the
    // screen has less room; the current entry is scrolled into view.
    private var list: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(picker.entries.enumerated()), id: \.offset) { _, entry in
                        row(entry)
                    }
                }
                .padding(.bottom, 2)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(.hidden)
            .frame(maxHeight: contentHeight > 0 ? min(contentHeight, 380) : 380)
            .onAppear {
                if let current = picker.entries.first(where: { $0.kind == .item && $0.current }) {
                    proxy.scrollTo(current.id, anchor: .center)
                }
            }
        }
    }

    @ViewBuilder private func row(_ entry: CommandPicker.Entry) -> some View {
        switch entry.kind {
        case .heading:
            Text(entry.label.uppercased())
                .font(.mono(10, .medium))
                .tracking(1)
                .foregroundStyle(Palette.subtle)
                .padding(.top, 14)
                .padding(.bottom, 6)
                .padding(.horizontal, 20)
                .accessibilityAddTraits(.isHeader)
        case .info:
            Text(entry.label)
                .font(.system(size: 13))
                .foregroundStyle(Palette.muted)
                .padding(.vertical, 6)
                .padding(.horizontal, 20)
        case .item:
            Button { choose(entry) } label: {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(entry.label)
                            .font(.system(size: 16, weight: entry.current ? .semibold : .regular))
                            .foregroundStyle(Palette.white)
                        if let description = entry.description, !description.isEmpty {
                            Text(description)
                                .font(.system(size: 13))
                                .foregroundStyle(Palette.muted)
                        }
                    }
                    .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    trailing(entry)
                        .frame(width: 20)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .frame(minHeight: 50)
                .background {
                    if entry.current || prompted?.id == entry.id {
                        RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Palette.fill)
                    }
                }
                .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            .buttonStyle(RowPress())
            .disabled(busy != nil)
            .padding(.horizontal, 6)
            .id(entry.id)
            .accessibilityAddTraits(entry.current ? .isSelected : [])
        case .other:
            EmptyView()
        }
    }

    // What a tap on the entry will do: it is running, it is what is set now,
    // or it asks for a value first.
    @ViewBuilder private func trailing(_ entry: CommandPicker.Entry) -> some View {
        if busy == entry.id {
            ProgressView().controlSize(.small).tint(Palette.muted)
        } else if entry.current {
            Image(systemName: "checkmark")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.platinum)
        } else if entry.prompt != nil {
            Image(systemName: prompted?.id == entry.id ? "chevron.down" : "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.subtle)
        }
    }

    private func field(_ prompt: CommandPicker.Entry.Prompt, for entry: CommandPicker.Entry) -> some View {
        VStack(spacing: 0) {
            Hairline().padding(.horizontal, 20)
            HStack(spacing: 10) {
                Group {
                    if prompt.secret {
                        SecureField("", text: $value, prompt: Text(prompt.text).foregroundStyle(Palette.subtle))
                    } else {
                        TextField("", text: $value, prompt: Text(prompt.text).foregroundStyle(Palette.subtle))
                    }
                }
                .focused($entryFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.system(size: 16))
                .foregroundStyle(Palette.white)
                .submitLabel(.done)
                .onSubmit(submit)
                Button(action: submit) {
                    Group {
                        if busy == entry.id {
                            ProgressView().controlSize(.small).tint(Palette.ground)
                        } else {
                            Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold))
                        }
                    }
                    .foregroundStyle(Palette.ground)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Palette.platinum))
                    .opacity(entered.isEmpty ? 0.4 : 1)
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
                }
                .buttonStyle(RowPress())
                .disabled(entered.isEmpty || busy != nil)
                .accessibilityLabel("Send \(prompt.text)")
            }
            .padding(.leading, 20)
            .padding(.trailing, 8)
            .padding(.top, 6)
        }
        .transition(.opacity)
        .task(id: entry.id) { entryFocused = true }
    }

    private var entered: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func choose(_ entry: CommandPicker.Entry) {
        guard let command = entry.command, busy == nil else { return }
        if entry.prompt != nil {
            if prompted?.id != entry.id { value = "" }
            prompted = entry
        } else {
            start(command, entry.id)
        }
    }

    private func submit() {
        guard let prompted, let command = prompted.command, !entered.isEmpty, busy == nil else { return }
        entryFocused = false
        start("\(command) \(entered)", prompted.id)
    }

    // Sirus's answer closes the menu, or puts the next one in its place;
    // until then the entry says it is working.
    private func start(_ command: String, _ id: String) {
        busy = id
        failure = nil
        Task {
            do { try await run(command) } catch { failure = error.localizedDescription }
            busy = nil
        }
    }
}
