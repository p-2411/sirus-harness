import SwiftUI

// A waiting approval or question, with who is asking, what for, and the
// answers. The conversation morphs an approval from the composer and a
// question from the status pill. Amber marks approvals, platinum questions.
struct RequestCard: View {
    let request: Request
    let waiting: Int
    let client: RemoteClient
    let names: Set<String>

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(tone)
                Text(request.requester).fontWeight(.semibold).foregroundStyle(Palette.platinum)
                    .truncationMode(.middle)
                Text(verb).foregroundStyle(Palette.muted).fixedSize()
                Spacer(minLength: 4)
                if waiting > 0 { Text("\(waiting) more").foregroundStyle(Palette.subtle).fixedSize() }
            }
            .font(.mono(12))
            .lineLimit(1)
            .padding(.horizontal, 20)
            .padding(.top, 18)
            switch request.kind {
            case .approval: ApprovalBody(request: request, client: client, names: names)
            case .question: QuestionBody(request: request, client: client)
            case .other:
                VStack(alignment: .leading, spacing: 8) {
                    if let title = request.title ?? request.message {
                        Bounded(limit: 220) {
                            Text(title).font(.system(size: 17, weight: .medium)).foregroundStyle(Palette.white)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    Text("Answer this in Sirus on your Mac.").font(.system(size: 14)).foregroundStyle(Palette.muted)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
            }
        }
    }

    private var tone: Color { request.kind == .approval ? Palette.amber : Palette.platinum }
    private var symbol: String {
        switch request.kind {
        case .approval: "exclamationmark.triangle.fill"
        case .question: "questionmark.bubble.fill"
        case .other: "ellipsis.bubble.fill"
        }
    }
    private var verb: String {
        switch request.kind {
        case .approval: "wants to"
        case .question: "asks"
        case .other: "needs you"
        }
    }
}

// Content that may be long sits in its own scroll, so the card never pushes
// the transcript off the screen: as tall as the content up to the limit,
// and shorter still when the keyboard leaves less room. Dragging it puts
// the keyboard away, as a number pad has no key for that.
private struct Bounded<Content: View>: View {
    let limit: CGFloat
    // What it keeps however short of room the card is.
    var minimum: CGFloat = 0
    @ViewBuilder let content: Content
    @State private var height: CGFloat = 0

    var body: some View {
        ScrollView {
            content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .frame(minHeight: min(height, minimum), maxHeight: min(max(height, 1), limit))
    }
}

private struct ApprovalBody: View {
    let request: Request
    let client: RemoteClient
    let names: Set<String>
    @State private var busy: String?
    @State private var failure: String?
    @State private var answered = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // What is being approved stays in view: at least its first lines,
            // with the answers scrolling first when there are many.
            Bounded(limit: 220, minimum: 96) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(request.title ?? "Use a tool")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(Palette.white)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(request.detail.enumerated()), id: \.offset) { _, block in
                        BlockView(block: block, names: names, color: Palette.muted, compact: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            if let failure {
                Text(failure).font(.system(size: 13)).foregroundStyle(Palette.red).lineLimit(3)
                    .padding(.horizontal, 20).padding(.bottom, 8)
            }
            // Allowing once is the prominent answer, else the first that
            // allows. Vendors can list a broader grant first, such as leaving
            // plan mode with permissions bypassed, and that should never be
            // the easy tap.
            let prominent = (request.options.first(where: { $0.kind == "allow_once" })
                ?? request.options.first(where: { !$0.rejects }))?.id
            // The answers keep their room before the detail does, and scroll
            // too once even they don't fit, so the card never grows past
            // the top of the screen.
            Bounded(limit: .infinity) {
                VStack(spacing: 8) {
                    ForEach(request.options) { option in
                        let primary = option.id == prominent
                        Button { choose(option) } label: {
                            HStack(spacing: 10) {
                                if busy == option.id {
                                    ProgressView().controlSize(.small).tint(primary ? Palette.ground : Palette.muted)
                                } else {
                                    Image(systemName: glyph(option.kind)).font(.system(size: 14, weight: .semibold))
                                }
                                Text(option.label)
                                    .font(.system(size: 16, weight: primary ? .semibold : .medium))
                                    .multilineTextAlignment(.leading)
                                    .lineLimit(3)
                            }
                            .foregroundStyle(primary ? Palette.ground : Palette.white)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 8)
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(Capsule().fill(primary ? AnyShapeStyle(Palette.platinum) : AnyShapeStyle(Palette.fill)))
                            .contentShape(Capsule())
                        }
                        .buttonStyle(RowPress())
                        .disabled(busy != nil)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 4)
            }
            .layoutPriority(1)
        }
        .padding(.bottom, 12)
        .sensoryFeedback(.impact(weight: .medium), trigger: answered)
    }

    private func glyph(_ kind: String) -> String {
        switch kind {
        case "allow_once": "checkmark"
        case "allow_always": "checkmark.circle"
        case "reject_always": "xmark.circle"
        default: kind.hasPrefix("reject") ? "xmark" : "arrow.right"
        }
    }

    private func choose(_ option: ApprovalOption) {
        answered += 1
        busy = option.id
        failure = nil
        Task {
            do { try await client.approve(requestId: request.id, optionId: option.id) }
            catch { failure = error.localizedDescription; busy = nil }
        }
    }
}

// A question card: every field of the form in one scroll, answered the way
// the TUI's QuestionCard answers it. A lone single-choice question is sent
// the moment an option is tapped.
private struct QuestionBody: View {
    let request: Request
    let client: RemoteClient
    @State private var chosen: [String: String] = [:]        // single choice and yes/no
    @State private var picked: [String: [String]] = [:]      // multiple choice, in tap order
    @State private var otherOn: Set<String> = []             // fields with "Other…" chosen
    @State private var typed: [String: String] = [:]         // text, number and "Other…" answers
    @State private var failure: String?
    @State private var busy = false
    @State private var answered = 0

    private var instant: Bool {
        guard request.fields.count == 1, let field = request.fields.first else { return false }
        return field.kind == .boolean || (field.kind == .choice && !field.multiple)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Bounded(limit: 360) {
                VStack(alignment: .leading, spacing: 22) {
                    if request.fields.count > 1, let message = request.message, !message.isEmpty {
                        Text(message).font(.system(size: 16)).foregroundStyle(Palette.text)
                    }
                    ForEach(request.fields) { field in fieldView(field) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            if let failure {
                Text(failure).font(.system(size: 13)).foregroundStyle(Palette.red).lineLimit(3)
                    .padding(.horizontal, 20).padding(.bottom, 8)
            }
            HStack(spacing: 8) {
                Button { send(.decline) } label: {
                    Text("Decline")
                        .foregroundStyle(Palette.muted)
                        .padding(.horizontal, 20)
                        .frame(minHeight: 44)
                        .background(Capsule().fill(Palette.fill))
                        .contentShape(Capsule())
                }
                Spacer()
                if busy { ProgressView().controlSize(.small).tint(Palette.muted) }
                if !instant || otherOn.contains(request.fields.first?.key ?? "") {
                    Button(action: submit) {
                        Text("Send")
                            .foregroundStyle(Palette.ground)
                            .padding(.horizontal, 26)
                            .frame(minHeight: 44)
                            .background(Capsule().fill(Palette.platinum))
                            .contentShape(Capsule())
                    }
                    .disabled(busy || !answerable)
                }
            }
            .buttonStyle(RowPress())
            .font(.system(size: 16, weight: .semibold))
            .disabled(busy)
            .padding(.horizontal, 12)
            .padding(.top, 4)
            .padding(.bottom, 12)
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: answered)
    }

    private var answerable: Bool { !request.fields.contains { $0.kind == .other } }

    @ViewBuilder private func fieldView(_ field: QuestionField) -> some View {
        let text = questionText(field)
        VStack(alignment: .leading, spacing: 4) {
            if let label = text.label {
                Text(label.uppercased()).font(.mono(10, .medium)).tracking(1).foregroundStyle(Palette.subtle)
                    .padding(.bottom, 2)
            }
            Text(text.question)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Palette.white)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 6)
            switch field.kind {
            case .choice:
                ForEach(field.options, id: \.value) { option in
                    choice(option.label, detail: option.description, on: isOn(field, option.value)) {
                        toggle(field, option.value)
                    }
                }
                if let other = field.other {
                    choice("Other…", detail: nil, on: otherOn.contains(field.key)) {
                        if !field.multiple { chosen[field.key] = nil }
                        if otherOn.contains(field.key) { otherOn.remove(field.key) } else { otherOn.insert(field.key) }
                    }
                    if otherOn.contains(field.key) { entry(other.key, prompt: "Your answer") }
                }
            case .boolean:
                choice("Yes", detail: nil, on: chosen[field.key] == "true") { pick(field, "true") }
                choice("No", detail: nil, on: chosen[field.key] == "false") { pick(field, "false") }
            case .text:
                entry(field.key, prompt: field.required ? "Answer" : "Answer (optional)", secret: field.secret)
            case .number:
                entry(field.key, prompt: numberPrompt(field), keyboard: field.integer ? .numberPad : .decimalPad)
            case .other:
                Text("This can only be answered on your Mac.").font(.system(size: 14)).foregroundStyle(Palette.muted)
            }
        }
    }

    private func choice(_ label: String, detail: String?, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: on ? "circle.inset.filled" : "circle")
                    .font(.system(size: 15))
                    .foregroundStyle(on ? Palette.platinum : Palette.subtle)
                VStack(alignment: .leading, spacing: 3) {
                    Text(label).font(.system(size: 16)).foregroundStyle(on ? Palette.white : Palette.text)
                    if let detail, !detail.isEmpty {
                        Text(detail).font(.system(size: 13)).foregroundStyle(Palette.muted)
                    }
                }
                .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPress())
        .disabled(busy)
    }

    private func entry(_ key: String, prompt: String, secret: Bool = false, keyboard: UIKeyboardType = .default) -> some View {
        let binding = Binding(get: { typed[key] ?? "" }, set: { typed[key] = $0; failure = nil })
        return Group {
            if secret { SecureField("", text: binding, prompt: Text(prompt).foregroundStyle(Palette.subtle)) }
            else { TextField("", text: binding, prompt: Text(prompt).foregroundStyle(Palette.subtle), axis: .vertical) }
        }
        .font(.system(size: 16))
        .foregroundStyle(Palette.white)
        .keyboardType(keyboard)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white.opacity(0.07)))
        .padding(.top, 4)
    }

    private func numberPrompt(_ field: QuestionField) -> String {
        switch (field.minimum, field.maximum) {
        case let (low?, high?): return "\(numberText(low))–\(numberText(high))"
        case let (low?, nil): return "At least \(numberText(low))"
        case let (nil, high?): return "At most \(numberText(high))"
        default: return field.integer ? "A whole number" : "A number"
        }
    }

    private func isOn(_ field: QuestionField, _ value: String) -> Bool {
        field.multiple ? picked[field.key, default: []].contains(value) : chosen[field.key] == value
    }

    private func toggle(_ field: QuestionField, _ value: String) {
        failure = nil
        if field.multiple {
            var values = picked[field.key, default: []]
            if let index = values.firstIndex(of: value) { values.remove(at: index) } else { values.append(value) }
            picked[field.key] = values
        } else {
            pick(field, value)
        }
    }

    private func pick(_ field: QuestionField, _ value: String) {
        failure = nil
        chosen[field.key] = value
        otherOn.remove(field.key)
        if instant { submit() }
    }

    // The content QuestionCard would send: a single choice as its value, a
    // multiple one as a list, an answer of the user's own in the field the
    // agent named for it, and nothing for a question skipped.
    private func submit() {
        var content: [String: AnswerValue] = [:]
        for field in request.fields {
            let title = questionText(field).label ?? field.title
            switch field.kind {
            case .choice:
                let custom = field.other.flatMap { otherOn.contains(field.key) ? typed[$0.key]?.trimmingCharacters(in: .whitespacesAndNewlines) : nil } ?? ""
                if otherOn.contains(field.key) && custom.isEmpty { return fail("Enter your own answer for \(title).") }
                if field.multiple {
                    let values = picked[field.key, default: []]
                    // Counted in Double: the bounds come from the agent, and
                    // one past Int's range would trap in a conversion.
                    let minimum = max(field.required ? 1 : 0, (field.minimum ?? 0).rounded(.towardZero))
                    if custom.isEmpty && (field.required || !values.isEmpty) && Double(values.count) < minimum {
                        return fail("Choose at least \(numberText(minimum)) for \(title).")
                    }
                    if let maximum = field.maximum?.rounded(.towardZero), Double(values.count) > maximum {
                        return fail("Choose at most \(numberText(maximum)) for \(title).")
                    }
                    if !values.isEmpty || field.required || !custom.isEmpty { content[field.key] = .strings(values) }
                } else if let value = chosen[field.key] {
                    content[field.key] = .string(value)
                } else if custom.isEmpty && field.required {
                    return fail("Choose an answer for \(title).")
                }
                if !custom.isEmpty, let other = field.other {
                    content[other.key] = .string(custom)
                    if !field.multiple, let value = other.value { content[field.key] = .string(value) }
                }
            case .boolean:
                if let value = chosen[field.key] { content[field.key] = .boolean(value == "true") }
                else if field.required { return fail("Answer \(title).") }
            case .text:
                let value = typed[field.key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !value.isEmpty { content[field.key] = .string(value) }
                else if field.required { return fail("Enter an answer for \(title).") }
            case .number:
                let value = typed[field.key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if value.isEmpty {
                    if field.required { return fail("Enter a number for \(title).") }
                    continue
                }
                guard let number = Double(value.replacingOccurrences(of: ",", with: ".")), number.isFinite,
                      !field.integer || number.rounded() == number else {
                    return fail(field.integer ? "Enter a whole number for \(title)." : "Enter a number for \(title).")
                }
                if let minimum = field.minimum, number < minimum { return fail("\(title): at least \(numberText(minimum)).") }
                if let maximum = field.maximum, number > maximum { return fail("\(title): at most \(numberText(maximum)).") }
                content[field.key] = .number(number)
            case .other:
                return fail("This can only be answered on your Mac.")
            }
        }
        send(.accept(content))
    }

    // A whole number without its ".0", when it fits in an Int.
    private func numberText(_ value: Double) -> String {
        value.rounded() == value && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }

    private func fail(_ message: String) { failure = message }

    private func send(_ answer: QuestionAnswer) {
        answered += 1
        busy = true
        failure = nil
        Task {
            do { try await client.answer(requestId: request.id, answer) }
            catch { failure = error.localizedDescription; busy = false }
        }
    }

    // QuestionCard.tsx questionText: Claude puts a lone question in the message
    // and a short header in the title; Codex the question in the title and a
    // header in the description.
    private func questionText(_ field: QuestionField) -> (question: String, label: String?) {
        let single = request.fields.count == 1
        let candidates = [single ? request.message : nil, field.description, field.title].compactMap { $0 }.filter { !$0.isEmpty }
        let question = candidates.first { $0.trimmingCharacters(in: .whitespaces).hasSuffix("?") }
            ?? (single ? request.message.flatMap { $0.isEmpty ? nil : $0 } ?? field.title : field.title)
        let label = [field.title, field.description].compactMap { $0 }.first { $0 != question && $0.count <= 30 }
        return (question, label)
    }
}
