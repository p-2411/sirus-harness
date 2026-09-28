import SwiftUI

// What to check when the Mac can't be reached, in the order it usually goes
// wrong, with Tailscale's App Store page a tap away (it offers Open when
// the app is already installed). Setup shows it under a failed connect; the
// lobby when the Mac has gone quiet.
struct ConnectionHelp: View {
    static let tailscale = URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            check(1, "Tailscale is connected on this iPhone",
                  "Open the Tailscale app and turn it on. Installed isn't enough.")
            check(2, "Tailscale is connected on your Mac",
                  "Signed in as the same user as this iPhone, with the Mac awake.")
            check(3, "Sirus is sharing a session",
                  "Run `/rc` in a Sirus session on your Mac.")
            Button { openURL(Self.tailscale) } label: {
                Label("Tailscale on the App Store", systemImage: "arrow.up.forward.app")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Palette.white)
                    .frame(maxWidth: .infinity, minHeight: 36)
            }
            .buttonStyle(.glass)
            .padding(.top, 2)
        }
        .multilineTextAlignment(.leading)
        .padding(16)
        .background { RoundedRectangle(cornerRadius: 26, style: .continuous).fill(.white.opacity(0.05)) }
        .overlay { RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(Palette.line.opacity(0.6), lineWidth: 1) }
    }

    private func check(_ number: Int, _ title: String, _ detail: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(String(number))
                .font(.mono(11, .semibold))
                .foregroundStyle(Palette.muted)
                .frame(width: 22, height: 22)
                .background { Circle().fill(.white.opacity(0.08)) }
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Palette.text)
                Text(detail)
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
