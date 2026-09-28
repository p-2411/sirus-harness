import SwiftUI

// src/frontend/styles/theme.ts on the phone: platinum and arctic white on the
// near-black ground, gunmetal hairlines, periwinkle kept for mentions of
// known participants and the one green for tool activity. Amber and red are
// small marks only, where the TUI uses them: amber for what needs the user
// (and the sidebar's working spinner), red for what failed. Work in progress
// is silver, never a fill.
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
    // The faint fill of a control at rest on the ground or on glass.
    static let fill = Color.white.opacity(0.08)
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

// How things move, kept in one place so the whole app moves one way. Glass
// that travels (the sidebar, a menu, a picker, a card taking the input's
// place) springs on one curve with little bounce, as a large surface should
// land rather than wobble; small controls take a quicker spring with a
// touch more give; what changes in place eases without overshooting; what
// only appears or goes, fades. Each thing comes from where it belongs, the
// sidebar from the leading edge and the menus up out of the input, and
// goes back the way it came.
//
// With Reduce Motion on, nothing travels: springs lose their bounce and
// what would slide cross-fades, briefly. What moves is read from a value
// made with the setting; what is static moves nothing, so is the same
// either way.
struct Motion {
    var reduced = false

    // Glass that travels: the sidebar opening, a menu or picker rising, a
    // card taking the input's place, the rail stepping aside.
    var panel: Animation { reduced ? Self.fade : .spring(duration: 0.45, bounce: 0.16) }
    // A small thing changing state or place: the tabs' thumb, send turning
    // into stop, a note, the jump to the latest message.
    var snap: Animation { reduced ? .smooth(duration: 0.25) : .spring(duration: 0.3, bounce: 0.2) }

    // Content changing in place: a row opening, a line appearing or going,
    // the rail taking the marks that fit.
    static var settle: Animation { .smooth(duration: 0.28) }
    // What fades rather than moves: a control's tint, one screen or picker
    // giving way to the next, and whatever Reduce Motion keeps still.
    static var fade: Animation { .easeInOut(duration: 0.22) }
    // A row darkening under the finger, at once; it lets go on `fade`.
    static var press: Animation { .easeOut(duration: 0.12) }
    // A status dot breathing while something is in progress.
    static var breathe: Animation { .easeInOut(duration: 0.9).repeatForever(autoreverses: true) }

    // The `/` and `@` menu rising out of the input by the given distance.
    // It starts over the input, so it comes in clear rather than covering it.
    func menu(rising distance: CGFloat) -> AnyTransition {
        if reduced { return .opacity }
        return .offset(y: distance).combined(with: .opacity)
    }

    // A picker sliding up from the bottom edge, through the input's place,
    // as a sheet does: solid all the way, over a scrim that only fades.
    var sheet: AnyTransition {
        if reduced { return .opacity }
        return .move(edge: .bottom)
    }

    // A note slipping in a little way from the edge it keeps to.
    func note(from edge: VerticalEdge) -> AnyTransition {
        if reduced { return .opacity }
        return .offset(y: edge == .top ? -16 : 16).combined(with: .opacity)
    }

    // A small control appearing where it stands.
    var pop: AnyTransition {
        if reduced { return .opacity }
        return .scale(scale: 0.85).combined(with: .opacity)
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
            .animation(active ? Motion.breathe : Motion.fade, value: dim)
            .onAppear { dim = active }
            .onChange(of: active) { _, now in dim = now }
    }
}

// Rows darken a touch under the finger instead of flashing grey: at once
// on the touch, easing back on the release, as a system button does.
struct RowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.55 : 1)
            .animation(configuration.isPressed ? Motion.press : Motion.fade, value: configuration.isPressed)
    }
}

// The permission mode, which Sirus sends in the TUI's words ("ask for
// approval", "auto approve", "bypass permissions"), coloured as its status
// row colours it: muted when Sirus asks, amber when the vendor's reviewer
// decides, red when nothing is asked.
func permissionColor(_ mode: String) -> Color {
    let mode = mode.lowercased()
    if mode.hasPrefix("bypass") { return Palette.red }
    if mode.hasPrefix("auto") { return Palette.amber }
    return Palette.muted
}

// Puts the keyboard away, from whichever field has it.
@MainActor func dismissKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
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
