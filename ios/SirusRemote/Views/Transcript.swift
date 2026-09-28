import SwiftUI

// The rows, kept to the bottom while the reader is at the bottom and left
// alone once they scroll up to read. Rows are replaced in place as they
// stream, so nothing above the reader moves. They use the full width; the
// sidebar's rail floats over them. The rows are read here rather than by
// the conversation, so a streaming row redraws the transcript alone.
struct Transcript: View {
    let client: RemoteClient
    let sessionId: String
    let participant: String
    let names: Set<String>
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var pinned = true

    private struct Metrics: Equatable {
        let content: CGFloat
        let container: CGFloat
        let belowView: CGFloat
    }

    var body: some View {
        // Until this conversation's first view arrives, the rows are none
        // yet or another conversation's, so neither is shown.
        let ready = client.shows(sessionId, participant)
        let rows = ready ? client.rows : []
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    RowView(row: row, previous: index > 0 ? rows[index - 1] : nil, names: names)
                        .equatable()
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, 16)
        }
        .scrollPosition($position)
        .scrollEdgeEffectStyle(.soft, for: .vertical)
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .onScrollGeometryChange(for: Metrics.self) { geometry in
            Metrics(content: geometry.contentSize.height, container: geometry.containerSize.height,
                    belowView: geometry.contentSize.height - geometry.visibleRect.maxY)
        } action: { old, new in
            // Growth follows the reader only if they were at the bottom;
            // a scroll of their own decides whether they still are.
            if new.content != old.content || new.container != old.container {
                if pinned { position.scrollTo(edge: .bottom) }
            } else {
                pinned = new.belowView < 40
            }
        }
        .overlay {
            if !ready {
                Pulse(color: Palette.subtle, size: 7)
                    .accessibilityLabel("Loading the conversation")
            } else if rows.isEmpty {
                VStack(spacing: 12) {
                    Image(decorative: "Horse")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 44)
                        .foregroundStyle(Palette.line)
                    Text("No messages yet")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Palette.muted)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if !pinned {
                Button {
                    pinned = true
                    withAnimation(.smooth(duration: 0.3)) { position.scrollTo(edge: .bottom) }
                } label: {
                    Image(systemName: "arrow.down")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.platinum)
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("Jump to latest")
                .padding(.trailing, 14)
                .padding(.bottom, 10)
                .transition(.opacity.combined(with: .scale(scale: 0.85)))
            }
        }
        .animation(.easeOut(duration: 0.18), value: pinned)
        // Agents write links, and a sirus: one would ask to move the app to
        // another Mac; one in a conversation is never the user's own.
        .environment(\.openURL, OpenURLAction { url in
            url.scheme == "sirus" ? .discarded : .systemAction
        })
    }
}

// One row. The speaker's name heads a run of rows from them, as the TUI
// heads a message; tool calls under it are single quiet lines that open to
// their detail.
struct RowView: View, Equatable {
    let row: Row
    let previous: Row?
    let names: Set<String>

    private var labelled: Bool {
        guard [.user, .assistant, .tool, .other].contains(row.kind) else { return false }
        guard let previous else { return true }
        return previous.author != row.author || (previous.kind == .user) != (row.kind == .user)
            || previous.kind == .compaction
    }

    private var spacing: CGFloat {
        guard previous != nil else { return 14 }
        if labelled { return 30 }
        if row.kind == .tool && previous?.kind == .tool { return 8 }
        return 14
    }

    var body: some View {
        VStack(alignment: row.kind == .user ? .trailing : .leading, spacing: 8) {
            if labelled { label }
            switch row.kind {
            case .user:
                // What the user sent, on a quiet bubble, so a right-aligned
                // paragraph reads as one message rather than loose lines.
                Blocks(blocks: row.blocks, names: names, color: Palette.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background {
                        RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Palette.fill)
                    }
                    .padding(.leading, 40)
            case .tool:
                if let tool = row.tool { ToolLine(tool: tool, names: names) }
            case .notice:
                Text(row.blocks.map(\.text).filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.mono(12))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(3)
            case .compaction:
                Compaction(blocks: row.blocks, names: names)
            case .assistant, .other:
                Blocks(blocks: row.blocks, names: names, color: Palette.text)
            }
        }
        .frame(maxWidth: .infinity, alignment: row.kind == .user ? .trailing : .leading)
        .padding(.top, spacing)
    }

    private var label: some View {
        HStack(spacing: 8) {
            Text(row.author ?? (row.kind == .user ? "you" : "agent"))
                .font(.mono(13, .semibold))
                .foregroundStyle(row.kind == .user ? Palette.white : Palette.silver)
            if row.kind == .user, !row.to.isEmpty {
                Text("→ " + row.to.map { "@\($0)" }.joined(separator: ", "))
                    .font(.mono(12))
                    .foregroundStyle(Palette.muted)
            }
        }
    }
}

// "● Edit src/app.ts", the dot in the colour of how the call went, and how it
// ended when it did not end well. A tap opens the call's short detail.
private struct ToolLine: View {
    let tool: Tool
    let names: Set<String>
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // A tap opens the detail, or with none, the whole of a long title.
            Button {
                withAnimation(.smooth(duration: 0.22)) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Pulse(color: dot, active: tool.state == .running, size: 6)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] + 1 }
                    Text(tool.title)
                        .foregroundStyle(tool.state == .running ? Palette.text : Palette.muted)
                        .lineLimit(open ? nil : 2)
                        .multilineTextAlignment(.leading)
                    // How it ended stays in view however long the title.
                    if let ending {
                        Text("· \(ending)").foregroundStyle(endingColor).fixedSize()
                    }
                    Spacer(minLength: 0)
                }
                .font(.mono(12.5))
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPress())
            .accessibilityValue(ending ?? (tool.state == .running ? "running" : "done"))
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(tool.detail.enumerated()), id: \.offset) { _, block in
                        BlockView(block: block, names: names, color: Palette.muted, compact: true)
                    }
                }
                .padding(.leading, 16)
                .overlay(alignment: .leading) { Rectangle().fill(Palette.line).frame(width: 1) }
                .padding(.leading, 2)
                .transition(.opacity)
            }
        }
    }

    // As the TUI colours a call: quiet while it runs, green once done, red
    // when it failed or was declined, muted when stopped.
    private var dot: Color {
        switch tool.state {
        case .running, .other: Palette.subtle
        case .done: Palette.green
        case .failed, .declined: Palette.red
        case .cancelled: Palette.muted
        }
    }

    private var ending: String? {
        switch tool.state {
        case .failed: "failed"
        case .declined: "declined"
        case .cancelled: "cancelled"
        default: nil
        }
    }

    private var endingColor: Color { tool.state == .cancelled ? Palette.subtle : Palette.red }
}

// The runtime folded its conversation here: a rule, and on a tap the summary
// that is all the agent now knows of what came before.
private struct Compaction: View {
    let blocks: [Block]
    let names: Set<String>
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button { withAnimation(.smooth(duration: 0.22)) { open.toggle() } } label: {
                HStack(spacing: 12) {
                    Hairline()
                    Text(open ? "context compacted · hide" : "context compacted")
                        .font(.mono(11))
                        .foregroundStyle(Palette.subtle)
                        .fixedSize()
                    Hairline()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(blocks.isEmpty)
            if open { Blocks(blocks: blocks, names: names, color: Palette.muted) }
        }
        .padding(.vertical, 6)
    }
}

struct Blocks: View {
    let blocks: [Block]
    let names: Set<String>
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block, names: names, color: color)
            }
        }
    }
}

// One markdown block as Sirus split it. Only inline markdown is parsed here.
struct BlockView: View {
    let block: Block
    let names: Set<String>
    let color: Color
    var compact = false
    // Prose follows Dynamic Type; compact detail and chrome stay put.
    @ScaledMetric(relativeTo: .body) private var prose: CGFloat = 16

    var body: some View {
        switch block.kind {
        case .heading:
            Text(inline(block.text))
                .font(.system(size: prose + (block.level <= 1 ? 4 : block.level == 2 ? 2 : 0), weight: .semibold))
                .foregroundStyle(Palette.white)
                .padding(.top, 4)
        case .code:
            Code(text: block.text, language: block.language, compact: compact)
        case .quote:
            prose(block.text)
                .foregroundStyle(Palette.muted)
                .padding(.leading, 14)
                .overlay(alignment: .leading) { Rectangle().fill(Palette.line).frame(width: 2) }
        case .list:
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(block.items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(block.ordered ? "\(index + 1)." : "•")
                            .font(block.ordered ? .mono(compact ? 12 : prose - 2) : .system(size: compact ? 12 : prose - 1))
                            .foregroundStyle(Palette.subtle)
                            .frame(minWidth: 12, alignment: .leading)
                        prose(item)
                    }
                }
            }
        case .rule:
            Hairline().padding(.vertical, 6)
        case .paragraph, .other:
            prose(block.text)
        }
    }

    @ViewBuilder private func prose(_ text: String) -> some View {
        let rendered = inline(text)
        let protectedCode = String(rendered.characters).contains("\u{2060}")
        let label = Text(rendered)
            .font(compact ? .mono(12) : .system(size: prose))
            .lineSpacing(compact ? 2 : 4)
            .foregroundStyle(color)
        if protectedCode {
            label
                .textSelection(.disabled)
                .contextMenu {
                    Button("Copy") {
                        UIPasteboard.general.string = String(rendered.characters)
                            .replacingOccurrences(of: "\u{2060}", with: "")
                    }
                }
        } else {
            label.textSelection(.enabled)
        }
    }

    // Inline markdown, with code spans in platinum and `@name` tinted when
    // the name is a participant's.
    private func inline(_ source: String) -> AttributedString {
        var text = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(source)
        for run in Array(text.runs).reversed() where run.inlinePresentationIntent?.contains(.code) == true {
            let code = String(text[run.range].characters)
            // A span longer than a line would then break between any two
            // letters; it is left free to break at its own separators.
            guard code.count <= 30 else { continue }
            var protected = ""
            for index in code.indices {
                let character = code[index]
                let next = code.index(after: index)
                protected.append(character)
                if (character == "/" || character == "-" || character == "."),
                   next < code.endIndex, !code[next].isWhitespace {
                    protected.append("\u{2060}")
                }
            }
            text.replaceSubrange(run.range, with: AttributedString(protected, attributes: run.attributes))
        }
        for run in text.runs where run.inlinePresentationIntent?.contains(.code) == true {
            text[run.range].foregroundColor = Palette.platinum
            text[run.range].font = .mono(compact ? 12 : prose - 1.5)
        }
        guard source.contains("@") else { return text }
        let characters = Array(text.characters)
        var index = 0
        while index < characters.count {
            if characters[index] == "@", index == 0 || !isNameCharacter(characters[index - 1]) {
                var end = index + 1
                while end < characters.count, isNameCharacter(characters[end]) { end += 1 }
                if names.contains(String(characters[index + 1 ..< end])) {
                    let start = text.index(text.startIndex, offsetByCharacters: index)
                    let stop = text.index(text.startIndex, offsetByCharacters: end)
                    text[start ..< stop].foregroundColor = Palette.mention
                }
                index = end
            } else {
                index += 1
            }
        }
        return text
    }

    private func isNameCharacter(_ character: Character) -> Bool {
        character.isLetter || character.isNumber || character == "_" || character == "-"
    }
}

// Code as a block of mono, scrolling sideways rather than wrapping. A diff's
// added and removed lines take the TUI's green and red. Outside a tool's
// detail, the block names its language and has a copy button, since
// selecting a long block by hand is fiddly on a phone.
private struct Code: View {
    let text: String
    let language: String?
    let compact: Bool
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !compact {
                HStack(spacing: 8) {
                    if let language, !language.isEmpty {
                        Text(language).font(.mono(10)).foregroundStyle(Palette.subtle)
                    }
                    Spacer(minLength: 0)
                    Button(action: copy) {
                        HStack(spacing: 5) {
                            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 10, weight: .semibold))
                                .contentTransition(.symbolEffect(.replace))
                            Text(copied ? "Copied" : "Copy")
                        }
                        .font(.mono(10))
                        .foregroundStyle(copied ? Palette.platinum : Palette.subtle)
                        .padding(.leading, 16)
                        .frame(minHeight: 28)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(RowPress())
                    .accessibilityLabel(copied ? "Copied" : "Copy code")
                }
                .sensoryFeedback(.success, trigger: copied) { _, now in now }
            }
            ScrollView(.horizontal) {
                Text(highlighted)
                    .font(.mono(compact ? 11.5 : 12.5))
                    .lineSpacing(3)
                    .foregroundStyle(Palette.platinum)
                    .textSelection(.enabled)
                    .fixedSize()
                    .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)
        }
        .padding(.leading, 14)
        .overlay(alignment: .leading) { Rectangle().fill(Palette.line).frame(width: 2) }
    }

    private func copy() {
        UIPasteboard.general.string = text
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            copied = false
        }
    }

    private var highlighted: AttributedString {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let diff = language == "diff" || lines.contains { $0.hasPrefix("@@") }
        guard diff else { return AttributedString(text) }
        var result = AttributedString()
        for (index, line) in lines.enumerated() {
            var piece = AttributedString(line + (index < lines.count - 1 ? "\n" : ""))
            if line.hasPrefix("+") { piece.foregroundColor = Palette.green }
            else if line.hasPrefix("-") { piece.foregroundColor = Palette.red }
            else if line.hasPrefix("@@") { piece.foregroundColor = Palette.subtle }
            result += piece
        }
        return result
    }
}
