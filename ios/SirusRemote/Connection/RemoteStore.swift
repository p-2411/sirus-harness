import Foundation
import Network
import Observation

// The app's state: which Mac, a client per Sirus process on it, the sessions
// they list together, and which one is open. The host and the last session
// viewed are all it stores; there is nothing secret to keep.
@MainActor @Observable final class RemoteStore {
    private(set) var host = UserDefaults.standard.string(forKey: "host") ?? ""
    private(set) var clients: [RemoteClient] = []
    // Looks for Sirus under way; they can overlap, as a rescan and a link.
    private var scans = 0
    var scanning: Bool { scans > 0 }
    // Why the last look for Sirus failed, kept whole so the screens can say
    // what to check rather than only that it failed.
    private(set) var problem: HostScanner.Failure?
    var openSession: String?

    // Observed, so a tab chosen in the conversation switches it at once.
    private var participants: [String: String] = [:]
    @ObservationIgnored private var openedAtLaunch = false
    // Counts connects, so the newest decides the Mac rather than the slowest.
    @ObservationIgnored private var connects = 0
    // In front: sockets are only opened then.
    @ObservationIgnored private var active = true
    @ObservationIgnored private var device: (token: String, environment: String)?
    @ObservationIgnored private var monitor: NWPathMonitor?

    // Two Sirus processes can serve the same session. Each session is taken
    // from a port that can be reached, then the one that saw it last, then
    // the one where it is working, then the lower port; that port is the one
    // it is driven through. A process that quit keeps its last list, so
    // without the first rule it could hold on to a session another serves.
    private var owned: [String: (client: RemoteClient, session: RemoteSession)] {
        var owned: [String: (client: RemoteClient, session: RemoteSession)] = [:]
        for client in clients {
            for session in client.sessions {
                if let current = owned[session.id] {
                    let currentLive = current.client.link == .live
                    if currentLive != (client.link == .live) {
                        if currentLive { continue }
                    } else if current.session.lastActivity > session.lastActivity
                        || (current.session.lastActivity == session.lastActivity && (current.session.working || !session.working)) {
                        continue
                    }
                }
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

    // The participant a session opens on: the one chosen there last, else
    // Sirus's own. The session opened at launch takes the terminal's choice.
    func participant(for sessionId: String) -> String {
        participants[sessionId] ?? "sirus"
    }

    // Finds the Sirus processes on a host and, when there are any, makes it
    // the Mac this app talks to.
    @discardableResult
    func connect(to raw: String) async -> Bool {
        guard let host = HostScanner.normalize(raw) else {
            problem = .invalid
            return false
        }
        connects += 1
        let attempt = connects
        scans += 1
        defer { scans -= 1 }
        do {
            let endpoints = try await HostScanner.scan(host)
            // A later connect, to this Mac or another, decides instead.
            guard attempt == connects else { return false }
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
            if attempt == connects { problem = error }
            return false
        }
    }

    // Looks again for processes that started or stopped listening, keeping
    // the sockets that are still good.
    func rescan() async {
        guard !host.isEmpty, !scanning else { return }
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
        active = true
        watchNetwork()
        clients.forEach { $0.start() }
        Task { await rescan() }
    }

    func background() {
        active = false
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

    // Takes up the processes a scan found. One that is live stays even if
    // its answer to the scan was slow; one that is gone is let go.
    private func adopt(_ endpoints: [Endpoint]) {
        let keeps = { (client: RemoteClient) in endpoints.contains(client.endpoint) || client.link == .live }
        let kept = clients.filter(keeps)
        clients.filter { !keeps($0) }.forEach { $0.stop() }
        let added = endpoints.filter { endpoint in !kept.contains { $0.endpoint == endpoint } }.map { endpoint in
            let client = RemoteClient(endpoint: endpoint)
            client.onLive = { [weak self] client in self?.clientBecameLive(client) }
            client.onSessions = { [weak self] _ in self?.openAtLaunch() }
            return client
        }
        clients = (kept + added).sorted { $0.endpoint.port < $1.endpoint.port }
        // A scan that ends after the app went away leaves the sockets for
        // foreground() to open.
        guard active else { return }
        added.forEach { $0.start() }
        watchNetwork()
    }

    private func clientBecameLive(_ client: RemoteClient) {
        guard let device else { return }
        Task { try? await client.registerDevice(token: device.token, environment: device.environment) }
    }

    // Once per launch, and again for a new Mac: open at the terminal's
    // focus if it is remote controlled, else at the session viewed last,
    // else at the most recent.
    private func openAtLaunch() {
        guard !openedAtLaunch, openSession == nil, let first = sessions.first else { return }
        openedAtLaunch = true
        if let focus = clients.compactMap(\.focus).max(by: { $0.at < $1.at }), session(focus.sessionId) != nil {
            open(focus.sessionId, participant: focus.participant)
        } else if let last = UserDefaults.standard.string(forKey: "lastSession"), session(last) != nil {
            open(last)
        } else {
            open(first.id)
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
