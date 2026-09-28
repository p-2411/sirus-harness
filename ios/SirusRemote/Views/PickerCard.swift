import SwiftUI

// A command menu takes the composer's glass. Entries and follow-up prompts
// come from the server, in the same order as the terminal's picker.
struct PickerCard: View {
    let picker: CommandPicker
    let dismiss: () -> Void
    let send: (String) -> Void
    @State private var prompted: CommandPicker.Entry?
    @State private var value = ""
    @State private var contentHeight: CGFloat = 1
    @FocusState private var entryFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(picker.title)
                    .font(.mono(15, .semibold))
                    .foregroundStyle(Palette.white)
                Spacer()
                Button(action: dismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Palette.muted)
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(RowPress())
                .accessibilityLabel("Close picker")
            }
            .padding(.leading, 20)
            .padding(.trailing, 6)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(picker.entries.enumerated()), id: \.offset) { _, entry in
                        switch entry.kind {
                        case .heading:
                            Text(entry.label.uppercased())
                                .font(.mono(10, .medium))
                                .tracking(1)
                                .foregroundStyle(Palette.subtle)
                                .padding(.top, 14)
                                .padding(.bottom, 5)
                                .padding(.horizontal, 20)
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
                                            .font(.system(size: 15, weight: .medium))
                                            .foregroundStyle(Palette.white)
                                        if let description = entry.description {
                                            Text(description)
                                                .font(.system(size: 12))
                                                .foregroundStyle(Palette.muted)
                                        }
                                    }
                                    .multilineTextAlignment(.leading)
                                    Spacer(minLength: 0)
                                    if entry.current {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(Palette.platinum)
                                    }
                                }
                                .frame(minHeight: 48)
                                .padding(.horizontal, 20)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(RowPress())
                        case .other: EmptyView()
                        }
                    }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(max(contentHeight, 1), 310))
            if let prompted, let prompt = prompted.prompt {
                Hairline().padding(.horizontal, 20)
                HStack(spacing: 10) {
                    Group {
                        if prompt.secret {
                            SecureField(prompt.text, text: $value)
                        } else {
                            TextField(prompt.text, text: $value)
                        }
                    }
                    .focused($entryFocused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.white)
                    .submitLabel(.done)
                    .onSubmit(submit)
                    Button(action: submit) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Palette.ground)
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(Palette.platinum))
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(RowPress())
                    .disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send \(prompt.text)")
                }
                .padding(.leading, 20)
                .padding(.trailing, 10)
                .padding(.vertical, 6)
            }
        }
        .padding(.bottom, 9)
        .gesture(DragGesture(minimumDistance: 30).onEnded { if $0.translation.height > 65 { dismiss() } })
    }

    private func choose(_ entry: CommandPicker.Entry) {
        guard let command = entry.command else { return }
        if entry.prompt != nil {
            value = ""
            prompted = entry
            entryFocused = true
        } else { send(command) }
    }

    private func submit() {
        guard let command = prompted?.command else { return }
        let entered = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !entered.isEmpty else { return }
        send("\(command) \(entered)")
        prompted = nil
        value = ""
    }
}
