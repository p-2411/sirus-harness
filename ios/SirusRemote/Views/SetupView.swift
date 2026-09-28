import SwiftUI

// First run: the QR code from `/rc` opens the app already configured; this
// screen is for the host typed by hand. A failed connect says why, and
// when that is Tailscale, what to check, with Tailscale a tap away.
struct SetupView: View {
    let store: RemoteStore
    @State private var host = ""
    @FocusState private var typing: Bool

    // The checklist stands in for the introduction while it is needed, and
    // steps aside while a new name is typed. Typing folds the introduction
    // away too, so the field has room above the keyboard.
    private var helps: Bool {
        !typing && !store.scanning && store.problem?.concernsTailscale == true
    }
    private var compact: Bool { typing || helps }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 24)
            Image("Horse")
                .resizable()
                .scaledToFit()
                .frame(width: compact ? 64 : 96)
                .foregroundStyle(Palette.platinum)
                .padding(.bottom, compact ? 18 : 28)
            Text("Sirus")
                .font(.system(size: 34, weight: .medium))
                .tracking(-0.6)
                .foregroundStyle(Palette.white)
            Text("REMOTE")
                .font(.mono(11, .medium))
                .tracking(3)
                .foregroundStyle(Palette.muted)
                .padding(.top, 4)
            if helps {
                ConnectionHelp()
                    .padding(.top, 24)
                    .transition(.opacity)
            } else if !typing {
                Text("Your sessions, from your pocket. On your Mac, run `/rc` in a Sirus session and scan the code it shows with the Camera.")
                    .font(.system(size: 16))
                    .lineSpacing(4)
                    .foregroundStyle(Palette.muted)
                    .padding(.top, 28)
                    .transition(.opacity)
            }
            Spacer(minLength: 24)
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
                    .textContentType(.URL)
                    .submitLabel(.go)
                    .focused($typing)
                    .onSubmit(connect)
                Button(action: connect) {
                    Group {
                        if store.scanning {
                            ProgressView().controlSize(.small).tint(Palette.ground)
                        } else {
                            Image(systemName: "arrow.right").font(.system(size: 16, weight: .bold))
                        }
                    }
                    .foregroundStyle(canConnect || store.scanning ? Palette.ground : Palette.subtle)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(canConnect || store.scanning ? Palette.platinum : .white.opacity(0.08)))
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
            status
                .frame(minHeight: 44, alignment: .topLeading)
                .padding(.top, 14)
                .padding(.horizontal, 20)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .frame(maxWidth: 520, alignment: .leading)
        .frame(maxWidth: .infinity)
        // A tap anywhere else puts the keyboard away.
        .background {
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { typing = false }
        }
        .animation(.smooth(duration: 0.3), value: helps)
        .animation(.smooth(duration: 0.3), value: typing)
        .animation(.easeOut(duration: 0.2), value: store.scanning)
        .sensoryFeedback(.error, trigger: store.problem?.errorDescription) { _, new in new != nil }
    }

    // Under the field: the look in progress, or what stopped the last one.
    @ViewBuilder private var status: some View {
        if store.scanning {
            HStack(spacing: 8) {
                Pulse(color: Palette.silver, size: 6)
                Text(looking)
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .font(.mono(12))
        } else if let problem = store.problem?.errorDescription {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.red)
                Text(problem)
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // A look from a QR code or a link has nothing typed to name.
    private var looking: String {
        guard let name = HostScanner.normalize(host) else { return "Looking for Sirus…" }
        return "Looking for Sirus on \(name)…"
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
