import SwiftUI

// src/frontend/styles/theme.ts on the phone: platinum and arctic white on the
// near-black ground, gunmetal hairlines, periwinkle kept for mentions of
// known participants, amber for work in progress and the one green for tool
// activity.
enum Palette {
    static let ground = Color(hex: 0x0C0E11)
    static let platinum = Color(hex: 0xC8CDD5)
    static let silver = Color(hex: 0xAEB5BF)
    static let white = Color(hex: 0xF2F3F5)
    static let text = Color(hex: 0xDDE0E4)
    static let muted = Color(hex: 0x8B919B)
    static let subtle = Color(hex: 0x5C616B)
    static let line = Color(hex: 0x33373E)
    static let mention = Color(hex: 0x8B93D6)
    static let amber = Color(hex: 0xE3B341)
    static let green = Color(hex: 0x00C853)
    static let red = Color(hex: 0xBF6A6A)
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

extension Font {
    // SF Mono for chrome: names, tool rows, status.
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

// One device pixel of gunmetal.
struct Hairline: View {
    var color = Palette.line
    @Environment(\.displayScale) private var scale

    var body: some View {
        Rectangle().fill(color).frame(height: 1 / scale)
    }
}

// A small status dot that breathes while something is in progress.
struct Pulse: View {
    let color: Color
    var active = true
    var size: CGFloat = 6
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .opacity(active && dim ? 0.3 : 1)
            .animation(active ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : .default, value: dim)
            .onAppear { dim = active }
            .onChange(of: active) { _, now in dim = now }
    }
}

// Rows darken a touch under the finger instead of flashing grey.
struct RowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.55 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// The permission mode in the TUI's words ("ask for approval", "auto
// approve", "bypass permissions"), coloured as its status row colours it:
// muted when Sirus asks, amber when the vendor's reviewer decides, red when
// nothing is asked.
func permissionMode(_ raw: String?) -> (name: String, color: Color)? {
    guard let raw, !raw.isEmpty else { return nil }
    let mode = raw.lowercased()
    if mode.hasPrefix("bypass") { return (raw, Palette.red) }
    if mode.hasPrefix("auto") { return (raw, Palette.amber) }
    return (raw, Palette.muted)
}

func elapsed(since milliseconds: Double, now: Date) -> String {
    let seconds = max(0, Int(now.timeIntervalSince1970 - milliseconds / 1000))
    return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
}

func ago(_ milliseconds: Double, now: Date = .now) -> String {
    guard milliseconds > 0 else { return "" }
    let seconds = max(0, Int(now.timeIntervalSince1970 - milliseconds / 1000))
    switch seconds {
    case ..<60: return "now"
    case ..<3600: return "\(seconds / 60)m"
    case ..<86400: return "\(seconds / 3600)h"
    default: return "\(seconds / 86400)d"
    }
}
