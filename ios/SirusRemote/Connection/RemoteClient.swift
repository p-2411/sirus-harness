import Foundation
import Observation

// One WebSocket to one Sirus process: its session list, the one conversation
// subscribed to, and requests answered by id. It reconnects with backoff
// while the app is in front, and resubscribes when it does.
@MainActor @Observable final class RemoteClient {
    enum Link { case connecting, live, offline }

    let endpoint: Endpoint
    private(set) var link = Link.connecting
    private(set) var sessions: [RemoteSession] = []
    private(set) var focus: Focus?

    // The subscribed conversation. Rows are upserted by id, so a row that is
    // still being written is replaced where it stands.
    private(set) var subscription: (sessionId: String, participant: String)?
    private(set) var header: Header?
    private(set) var rows: [Row] = []
    private(set) var requests: [Request] = []

    @ObservationIgnored var onSessions: (@MainActor (RemoteClient) -> Void)?
    @ObservationIgnored var onLive: (@MainActor (RemoteClient) -> Void)?

    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var retry: Task<Void, Never>?
    @ObservationIgnored private var attempts = 0
    @ObservationIgnored private var running = false
    @ObservationIgnored private var sequence = 0
    @ObservationIgnored private var pending: [String: CheckedContinuation<ResultFrame, Error>] = [:]

    init(endpoint: Endpoint) { self.endpoint = endpoint }

    func start() {
        running = true
        if socket == nil || link == .offline { connect() }
    }

    // Closes the socket while the app is away; start() brings it back.
    func stop() {
        running = false
        retry?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        link = .offline
        failPending(RemoteError("Disconnected from Sirus."))
    }

    func subscribe(sessionId: String, participant: String) async throws {
        if subscription?.sessionId != sessionId {
            header = nil
            requests = []
        }
        // Another agent in the same session keeps the header, tabs included,
        // so the switch animates; only its conversation starts afresh.
        if subscription?.sessionId != sessionId || subscription?.participant != participant {
            subscription = (sessionId, participant)
            rows = []
        }
        _ = try await request(.subscribe(sessionId, participant))
    }

    func send(_ text: String, sessionId: String, participant: String) async throws -> String? {
        try await request(.send(sessionId, participant, text)).feedback
    }

    func cancel(sessionId: String) async throws { _ = try await request(.cancel(sessionId)) }

    func approve(requestId: String, optionId: String) async throws {
        _ = try await request(.approve(requestId, optionId))
    }

    func answer(requestId: String, _ answer: QuestionAnswer) async throws {
        _ = try await request(.answer(requestId, answer))
    }

    func registerDevice(token: String, environment: String) async throws {
        _ = try await request(.device(token, environment))
    }

    private func connect() {
        retry?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        failPending(RemoteError("Lost the connection to Sirus."))
        guard let url = endpoint.socketURL else { link = .offline; return }
        let task = URLSession.shared.webSocketTask(with: url)
        task.maximumMessageSize = 16 << 20
        socket = task
        link = .connecting
        task.resume()
        Task { await receive(task) }
    }

    private func receive(_ task: URLSessionWebSocketTask) async {
        do {
            while true {
                let message = try await task.receive()
                guard socket === task else { return }
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let bytes): data = bytes
                @unknown default: continue
                }
                if link != .live { becameLive() }
                switch ServerFrame.decode(data) {
                case .sessions(let frame):
                    if sessions != frame.sessions { sessions = frame.sessions }
                    if focus != frame.focus { focus = frame.focus }
                    onSessions?(self)
                case .view(let frame): apply(frame)
                case .result(let result):
                    guard let continuation = pending.removeValue(forKey: result.id) else { break }
                    if result.ok { continuation.resume(returning: result) }
                    else { continuation.resume(throwing: RemoteError(result.error ?? "Sirus could not do that.")) }
                case nil: break
                }
            }
        } catch {
            guard socket === task else { return }
            socket = nil
            link = .offline
            failPending(RemoteError("Lost the connection to Sirus."))
            scheduleRetry()
        }
    }

    // The server greets a new socket with the session list; a reconnect
    // takes up the conversation it had open.
    private func becameLive() {
        link = .live
        attempts = 0
        onLive?(self)
        if let subscription {
            Task { try? await request(.subscribe(subscription.sessionId, subscription.participant)) }
        }
    }

    private func scheduleRetry() {
        guard running else { return }
        attempts += 1
        let delay = min(30, 1 << min(attempts - 1, 5))
        retry = Task {
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, running, link != .live else { return }
            connect()
        }
    }

    private func apply(_ frame: ViewFrame) {
        guard subscription?.sessionId == frame.sessionId, subscription?.participant == frame.participant else { return }
        if let header = frame.header, header != self.header { self.header = header }
        if requests != frame.requests { requests = frame.requests }
        if frame.reset {
            if rows != frame.rows { rows = frame.rows }
            return
        }
        guard !frame.rows.isEmpty || !frame.removed.isEmpty else { return }
        var next = rows
        if !frame.removed.isEmpty {
            let removed = Set(frame.removed)
            next.removeAll { removed.contains($0.id) }
        }
        var positions = Dictionary(next.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        for row in frame.rows {
            if let index = positions[row.id] { next[index] = row }
            else { positions[row.id] = next.count; next.append(row) }
        }
        rows = next
    }

    private func request(_ frame: ClientFrame) async throws -> ResultFrame {
        guard let socket, link == .live else { throw RemoteError("Not connected to Sirus.") }
        sequence += 1
        var frame = frame
        frame.id = String(sequence)
        let id = frame.id
        let text = String(decoding: try JSONEncoder().encode(frame), as: UTF8.self)
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            socket.send(.string(text)) { error in
                guard let error else { return }
                Task { @MainActor in self.pending.removeValue(forKey: id)?.resume(throwing: error) }
            }
        }
    }

    private func failPending(_ error: Error) {
        let waiting = pending.values
        pending.removeAll()
        for continuation in waiting { continuation.resume(throwing: error) }
    }
}

struct RemoteError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
