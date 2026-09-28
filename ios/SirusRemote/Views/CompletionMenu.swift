import SwiftUI

// The server sends nearest matches last; the bottom row stays beside the
// composer, including when there are more results than fit on screen.
struct CompletionMenu: View {
    let items: [CompletionItem]
    let choose: (CompletionItem) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(items) { item in
                        Button { choose(item) } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 9) {
                                Text(item.label)
                                    .font(.mono(13, .medium))
                                    .foregroundStyle(item.kind == .participant ? Palette.mention : Palette.white)
                                    .lineLimit(1)
                                if let tag = item.tag {
                                    Text("(\(tag))").font(.mono(10)).foregroundStyle(Palette.subtle)
                                }
                                Spacer(minLength: 0)
                                Text(item.description)
                                    .font(.system(size: 12))
                                    .foregroundStyle(Palette.muted)
                                    .lineLimit(1)
                            }
                            .padding(.horizontal, 16)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(RowPress())
                        .id(item.id)
                        if item.id != items.last?.id {
                            Hairline().padding(.horizontal, 16)
                        }
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: CGFloat(min(items.count, 5) * 45))
            .onAppear { if let last = items.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            .onChange(of: items.last?.id) { _, last in
                if let last { proxy.scrollTo(last, anchor: .bottom) }
            }
        }
        .glassEffect(.regular, in: .rect(cornerRadius: 20, style: .continuous))
    }
}
