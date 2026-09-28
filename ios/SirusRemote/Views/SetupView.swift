import SwiftUI

// First run: the QR code from `/rc` opens the app already configured; this
// screen is for the host typed by hand.
struct SetupView: View {
    let store: RemoteStore
    @State private var host = ""
    @FocusState private var typing: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 40)
            Image("Horse")
                .resizable()
                .scaledToFit()
                .frame(width: 96)
                .foregroundStyle(Palette.platinum)
                .padding(.bottom, 28)
            Text("Sirus")
                .font(.system(size: 34, weight: .medium))
                .tracking(-0.6)
                .foregroundStyle(Palette.white)
            Text("REMOTE")
                .font(.mono(11, .medium))
                .tracking(3)
                .foregroundStyle(Palette.muted)
                .padding(.top, 4)
            Text("Your sessions, from your pocket. On your Mac, run `/rc` in a Sirus session and scan the code it shows with the Camera.")
                .font(.system(size: 16))
                .lineSpacing(4)
                .foregroundStyle(Palette.muted)
                .padding(.top, 28)
            Spacer(minLength: 40)
            Text("OR ENTER YOUR MAC'S TAILSCALE NAME")
                .font(.mono(10, .medium))
                .tracking(1.5)
                .foregroundStyle(Palette.subtle)
                .padding(.leading, 20)
                .padding(.bottom, 10)
            HStack(spacing: 8) {
                TextField("", text: $host, prompt: Text("mac.tailnet.ts.net").foregroundStyle(Palette.subtle))
                    .font(.mono(16))
                    .foregroundStyle(Palette.white)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .focused($typing)
                    .onSubmit(connect)
                Button(action: connect) {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(canConnect ? Palette.ground : Palette.subtle)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(canConnect ? Palette.platinum : .white.opacity(0.08)))
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canConnect)
                .accessibilityLabel("Connect")
            }
            .padding(.leading, 20)
            .padding(.trailing, 4)
            .padding(.vertical, 4)
            .glassEffect(.regular.interactive(), in: .capsule)
            .animation(.easeOut(duration: 0.15), value: canConnect)
            Group {
                if store.scanning {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small).tint(Palette.silver)
                        Text("Looking for Sirus…").foregroundStyle(Palette.muted)
                    }
                    .font(.mono(12))
                } else if let problem = store.problem {
                    Text(problem).font(.system(size: 13)).foregroundStyle(Palette.red)
                }
            }
            .frame(minHeight: 44, alignment: .topLeading)
            .padding(.top, 14)
            .padding(.horizontal, 20)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeOut(duration: 0.2), value: store.scanning)
    }

    private var canConnect: Bool {
        !store.scanning && !host.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func connect() {
        guard canConnect else { return }
        typing = false
        Task { await store.connect(to: host) }
    }
}
