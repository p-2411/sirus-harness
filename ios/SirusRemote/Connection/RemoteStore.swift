import Foundation
import Network
import Observation

// The app's state: which Mac, a client per Sirus process on it, the sessions
// they list together, and which one is open. The host is the only thing
// stored; there is nothing secret to keep.
@MainActor @Observable final class RemoteStore {
    private(set) var host = UserDefaults.standard.string(forKey: "host") ?? ""
    private(set) var clients: [RemoteClient] = []
    private(set) var scanning = false
    private(set) var problem: String?
    var openSession: String?

    @ObservationIgnored private var participants: [String: String] = [:]
    @ObservationIgnored private var openedAtLaunch = false
    @ObservationIgnored private var device: (token: String, environment: String)?
    @ObservationIgnored private var monitor: NWPathMonitor?

    // Two Sirus processes can serve the same session. Each session is taken
    // from the port that saw it last (then the one where it is working, then
    // the lower port), and that port is the one it is driven through.
    private var owned: [String: (client: RemoteClient, session: RemoteSession)] {
        var owned: [String: (client: RemoteClient, session: RemoteSession)] = [:]
        for client in clients {
            for session in client.sessions {
                if let current = owned[session.id]?.session, current.lastActivity > session.lastActivity
                    || (current.lastActivity == session.lastActivity && (current.working || !session.working)) { continue }
                owned[session.id] = (client, session)
            }
        }
        return owned
    }

    var sessions: [RemoteSession] {
        owned.values.map(\.session).sorted { $0.lastActivity > $1.lastActivity }
    }

    var link: RemoteClient.Link {
        if clients.contains(where: { $0.link == .live }) { return .live }
        return clients.contains(where: { $0.link == .connecting }) || scanning ? .connecting : .offline
    }

    func client(for sessionId: String) -> RemoteClient? { owned[sessionId]?.client }

    func session(_ id: String) -> RemoteSession? { sessions.first { $0.id == id } }

    // The participant a session opens on: the one chosen there last, or the
    // one Sirus says was last selected in the terminal.
    func participant(for sessionId: String) -> String {
        participants[sessionId] ?? "sirus"
    }

    // Finds the Sirus processes on a host and, when there are any, makes it
    // the Mac this app talks to.
    @discardableResult
    func connect(to raw: String) async -> Bool {
        guard let host = HostScanner.normalize(raw) else {
            problem = HostScanner.Failure.invalid.errorDescription
            return false
        }
        scanning = true
        defer { scanning = false }
        do {
            let endpoints = try await HostScanner.scan(host)
            if host != self.host {
                clients.forEach { $0.stop() }
                clients = []
                openSession = nil
                openedAtLaunch = false
            }
            self.host = host
            UserDefaults.standard.set(host, forKey: "host")
            problem = nil
            adopt(endpoints)
            Push.register(asking: true)
            return true
        } catch {
            problem = error.errorDescription
            return false
        }
    }

    // Looks again for processes that started or stopped listening, keeping
    // the sockets that are still good.
    func rescan() async {
        guard !host.isEmpty else { return }
        await connect(to: host)
    }

    func forget() {
        clients.forEach { $0.stop() }
        clients = []
        host = ""
        openSession = nil
        problem = nil
        UserDefaults.standard.removeObject(forKey: "host")
    }

    func foreground() {
        watchNetwork()
        clients.forEach { $0.start() }
        Task { await rescan() }
    }

    func background() {
        monitor?.cancel()
        monitor = nil
        clients.forEach { $0.stop() }
    }

    func open(_ sessionId: String, participant: String? = nil) {
        if let participant { participants[sessionId] = participant }
        UserDefaults.standard.set(sessionId, forKey: "lastSession")
        openSession = sessionId
    }

    func choose(_ participant: String, in sessionId: String) {
        participants[sessionId] = participant
    }

    // A notification tap: the push says which Mac, so a phone that has not
    // been set up, or was pointed elsewhere, still lands in the session.
    func open(fromPush sessionId: String, participant: String?, host pushHost: String?) {
        participants[sessionId] = participant ?? participants[sessionId]
        if let pushHost, let normal = HostScanner.normalize(pushHost), normal != host {
            Task {
                if await connect(to: normal) { openSession = sessionId }
            }
        } else {
            openSession = sessionId
        }
    }

    func register(token: String, environment: String) {
        device = (token, environment)
        for client in clients where client.link == .live {
            Task { try? await client.registerDevice(token: token, environment: environment) }
        }
    }

    private func adopt(_ endpoints: [Endpoint]) {
        let kept = clients.filter { endpoints.contains($0.endpoint) }
        clients.filter { !endpoints.contains($0.endpoint) }.forEach { $0.stop() }
        let added = endpoints.filter { endpoint in !kept.contains { $0.endpoint == endpoint } }.map { endpoint in
            let client = RemoteClient(endpoint: endpoint)
            client.onLive = { [weak self] client in self?.clientBecameLive(client) }
            client.onSessions = { [weak self] _ in self?.openAtLaunch() }
            return client
        }
        clients = (kept + added).sorted { $0.endpoint.port < $1.endpoint.port }
        added.forEach { $0.start() }
        watchNetwork()
    }

    private func clientBecameLive(_ client: RemoteClient) {
        guard let device else { return }
        Task { try? await client.registerDevice(token: device.token, environment: device.environment) }
    }

    // Once per launch: open at the terminal's focus if it is remote
    // controlled, else at the session viewed last.
    private func openAtLaunch() {
        guard !openedAtLaunch, openSession == nil, !sessions.isEmpty else { return }
        openedAtLaunch = true
        if let focus = clients.compactMap(\.focus).max(by: { $0.at < $1.at }), session(focus.sessionId) != nil {
            open(focus.sessionId, participant: focus.participant)
        } else if let last = UserDefaults.standard.string(forKey: "lastSession"), session(last) != nil {
            open(last)
        }
    }

    private func watchNetwork() {
        guard monitor == nil, !clients.isEmpty else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in
                self?.clients.filter { $0.link == .offline }.forEach { $0.start() }
            }
        }
        monitor.start(queue: .main)
        self.monitor = monitor
    }
}
