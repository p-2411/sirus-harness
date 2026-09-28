import UIKit
import UserNotifications

// Pushes come from Sirus itself (src/remote/push.ts). Approvals carry action
// buttons that answer from the lock screen: the app wakes in the background,
// opens a socket of its own, sends `approve` with the option id Sirus put in
// the payload for that kind, and waits for the result.
enum Push {
    // One category for every set of buttons an approval can offer, so each
    // shows a button for just the kinds of option it has: one with nothing
    // to answer with could only fail.
    static func categories() -> Set<UNNotificationCategory> {
        // Allowing runs something on the Mac, so it needs the phone unlocked;
        // denying never needs to. The identifiers are the kinds they answer.
        let buttons = [
            UNNotificationAction(identifier: "allow_once", title: "Allow", options: [.authenticationRequired]),
            UNNotificationAction(identifier: "allow_always", title: "Always Allow", options: [.authenticationRequired]),
            UNNotificationAction(identifier: "reject_once", title: "Deny", options: [.destructive]),
        ]
        return Set((1..<(1 << buttons.count)).map { set -> UNNotificationCategory in
            let chosen = buttons.indices.filter { set & (1 << $0) != 0 }.map { buttons[$0] }
            return UNNotificationCategory(identifier: category(for: chosen.map(\.identifier)),
                                          actions: chosen, intentIdentifiers: [])
        })
    }

    // A set of buttons' category, named as Sirus names it (approvalFields in
    // src/remote/push.ts). The two sets nearly every approval offers keep
    // the names they always had.
    static func category(for kinds: [String]) -> String {
        switch kinds {
        case ["allow_once", "reject_once"]: "APPROVAL"
        case ["allow_once", "allow_always", "reject_once"]: "APPROVAL_ALWAYS"
        default: "APPROVAL:" + kinds.joined(separator: ",")
        }
    }

    // Asks once, after the first Mac is found; after that it only registers
    // again, for a token that may have changed.
    static func register(asking: Bool) {
        Task { @MainActor in
            let center = UNUserNotificationCenter.current()
            let ask = asking && !UserDefaults.standard.bool(forKey: "notificationsAsked")
            if ask { UserDefaults.standard.set(true, forKey: "notificationsAsked") }
            let allowed = ask
                ? (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                : await center.notificationSettings().authorizationStatus == .authorized
            if allowed { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    // What Sirus put under `sirus` in the payload.
    struct Payload: Sendable {
        let sessionId: String
        let participant: String?
        let requestId: String?
        let host: String?
        let port: Int?
        let options: [String: String]

        init?(_ userInfo: [AnyHashable: Any]) {
            guard let sirus = userInfo["sirus"] as? [String: Any], let sessionId = sirus["sessionId"] as? String else { return nil }
            self.sessionId = sessionId
            participant = sirus["participant"] as? String
            requestId = sirus["requestId"] as? String
            host = sirus["host"] as? String
            port = (sirus["port"] as? NSNumber)?.intValue
            options = sirus["options"] as? [String: String] ?? [:]
        }
    }

    // Answers an approval over a socket of its own, since the app may have
    // been woken just for this. Returns a sentence when it could not.
    static func approve(_ payload: Payload, kind: String) async -> String? {
        guard let requestId = payload.requestId, let optionId = payload.options[kind],
              let host = payload.host.flatMap(HostScanner.normalize), let port = payload.port,
              Endpoint.ports.contains(port), let url = Endpoint(host: host, port: port).socketURL else {
            return "This approval can't be answered from here. Open Sirus to answer it."
        }
        // The idle timeout bounds the wait: the app has about thirty seconds.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let socket = session.webSocketTask(with: url)
        socket.resume()
        var frame = ClientFrame.approve(requestId, optionId)
        frame.id = "push-\(UUID().uuidString)"
        do {
            try await socket.send(.string(try frame.encoded()))
            while true {
                guard case .string(let text) = try await socket.receive(),
                      case .result(let result) = ServerFrame.decode(Data(text.utf8)), result.id == frame.id else { continue }
                socket.cancel(with: .normalClosure, reason: nil)
                return result.ok ? nil : result.error ?? "Sirus could not take that answer."
            }
        } catch {
            return "Couldn't reach Sirus on \(host) (\(error.localizedDescription)). Open the app to answer."
        }
    }

    // Says what went wrong where the user was looking: in a notification.
    static func report(_ message: String, thread: String) async {
        let content = UNMutableNotificationContent()
        content.title = "Not answered"
        content.body = message
        content.threadIdentifier = thread
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let store = RemoteStore()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(Push.categories())
        Push.register(asking: false)
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        // Builds run from Xcode are signed for the APNs sandbox.
        #if DEBUG
        store.register(token: token, environment: "sandbox")
        #else
        store.register(token: token, environment: "production")
        #endif
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    // In front, the open conversation already shows its own requests.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let payload = Push.Payload(notification.request.content.userInfo)
        let showing = await MainActor.run { payload != nil && store.openSession == payload?.sessionId }
        return showing ? [.list] : [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let payload = Push.Payload(response.notification.request.content.userInfo) else { return }
        let action = response.actionIdentifier
        if action == UNNotificationDefaultActionIdentifier {
            await MainActor.run { store.open(fromPush: payload.sessionId, participant: payload.participant, host: payload.host) }
        } else if ["allow_once", "allow_always", "reject_once"].contains(action) {
            if let failure = await Push.approve(payload, kind: action) {
                await Push.report(failure, thread: payload.sessionId)
            }
        }
    }
}
