import Foundation

// Codable mirrors of remote control protocol v1, as agreed in
// docs/superpowers/specs/2026-09-28-remote-control-design.md. Sirus shapes
// everything; the app only draws it. The one compatibility rule is that
// whatever the app does not know it ignores: every field decodes on its own,
// a malformed row or request drops alone, and kinds the app has not heard of
// land on a neutral case.

struct Hello: Decodable {
    let `protocol`: Int
}

struct Focus: Decodable, Equatable {
    let sessionId: String
    let participant: String
    let at: Double
}

struct RemoteSession: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let directory: String
    let working: Bool
    // The session's last turn failed: the TUI's red mark.
    let failed: Bool
    let needsYou: Bool
    let lastActivity: Double
    // Grows with every agent output; the sidebar's unread rule reads it.
    let assistantVersion: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: "id")
        name = c.take("name") ?? "Untitled"
        directory = c.take("directory") ?? ""
        working = c.take("working") ?? false
        failed = (c.take("status") as String?) == "error"
        needsYou = c.take("needsYou") ?? false
        lastActivity = c.take("lastActivity") ?? 0
        assistantVersion = c.take("assistantVersion") ?? 0
    }
}

struct SessionsFrame: Decodable {
    let focus: Focus?
    let sessions: [RemoteSession]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        focus = c.take("focus")
        sessions = c.list("sessions")
    }
}

struct Participant: Decodable, Identifiable, Equatable {
    var id: String { name }
    let name: String
    let model: String?
    let vendor: String?
    let working: Bool
    let needsYou: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = try c.decode(String.self, forKey: "name")
        model = c.take("model")
        vendor = c.take("vendor")
        working = c.take("working") ?? false
        needsYou = c.take("needsYou") ?? false
    }
}

struct Status: Decodable, Equatable {
    let participant: String
    let thought: String?
    let startedAt: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        participant = c.take("participant") ?? ""
        thought = c.take("thought")
        startedAt = c.take("startedAt")
    }
}

struct Header: Decodable, Equatable {
    // The TUI's context gauge, in its words and its tone.
    struct Gauge: Decodable, Equatable {
        enum Tone: String { case subtle, warning, danger }
        let text: String
        let tone: Tone

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            text = c.take("text") ?? ""
            tone = Tone(rawValue: c.take("tone") ?? "") ?? .subtle
        }
    }

    let participants: [Participant]
    let status: Status?
    let queued: Int
    let permissionMode: String?
    let modeNotice: String?
    let context: Gauge?
    let thinking: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        participants = c.list("participants")
        status = c.take("status")
        queued = c.take("queued") ?? 0
        permissionMode = c.take("permissionMode")
        modeNotice = c.take("modeNotice")
        context = c.take("context")
        thinking = c.take("thinking")
    }
}

struct Block: Decodable, Equatable {
    enum Kind: String { case paragraph, heading, code, quote, list, rule, other }
    let kind: Kind
    let text: String
    let level: Int
    let language: String?
    let items: [String]
    let ordered: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        kind = Kind(rawValue: c.take("kind") ?? "") ?? .other
        text = c.take("text") ?? ""
        level = c.take("level") ?? 1
        language = c.take("language")
        items = c.list("items")
        ordered = c.take("ordered") ?? false
    }
}

struct Tool: Decodable, Equatable {
    enum State: String { case running, done, failed, declined, cancelled, other }
    let title: String
    let kind: String?
    let state: State
    let detail: [Block]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        title = c.take("title") ?? "Tool call"
        kind = c.take("kind")
        state = State(rawValue: c.take("state") ?? "") ?? .other
        detail = c.list("detail")
    }
}

struct Row: Decodable, Identifiable, Equatable {
    enum Kind: String { case user, assistant, tool, notice, compaction, other }
    let id: String
    let kind: Kind
    let author: String?
    let to: [String]
    let blocks: [Block]
    let tool: Tool?
    let time: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: "id")
        kind = Kind(rawValue: c.take("kind") ?? "") ?? .other
        author = c.take("author")
        to = c.list("to")
        blocks = c.list("blocks")
        tool = c.take("tool")
        time = c.take("time")
    }
}

struct ApprovalOption: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    // ACP option kinds: allow_once, allow_always, reject_once, reject_always.
    let kind: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: "id")
        kind = c.take("kind") ?? ""
        label = c.take("label") ?? kind
    }

    var rejects: Bool { kind.hasPrefix("reject") }
}

// src/agent_runtime/permissions/questions.ts QuestionField, flattened: the
// fields a kind does not have decode to their neutral values.
struct QuestionField: Decodable, Identifiable, Equatable {
    enum Kind: String { case choice, text, number, boolean, other }
    struct Option: Decodable, Equatable {
        let value: String
        let label: String
        let description: String?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            value = try c.decode(String.self, forKey: "value")
            label = c.take("label") ?? value
            description = c.take("description")
        }
    }
    // The field an answer of the user's own goes in, and for Codex the option
    // that says the answer is in it.
    struct Other: Decodable, Equatable {
        let key: String
        let value: String?
    }

    var id: String { key }
    let kind: Kind
    let key: String
    let title: String
    let description: String?
    let options: [Option]
    let multiple: Bool
    let required: Bool
    let minimum: Double?
    let maximum: Double?
    let other: Other?
    let secret: Bool
    let integer: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        key = try c.decode(String.self, forKey: "key")
        kind = Kind(rawValue: c.take("kind") ?? "") ?? .other
        title = c.take("title") ?? key
        description = c.take("description")
        options = c.list("options")
        multiple = c.take("multiple") ?? false
        required = c.take("required") ?? false
        minimum = c.take("minimum")
        maximum = c.take("maximum")
        other = c.take("other")
        secret = c.take("secret") ?? false
        integer = c.take("integer") ?? false
    }
}

struct Request: Decodable, Identifiable, Equatable {
    enum Kind: String { case approval, question, other }
    let id: String
    let kind: Kind
    let requester: String
    let title: String?
    let detail: [Block]
    let options: [ApprovalOption]
    let message: String?
    let fields: [QuestionField]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: "id")
        kind = Kind(rawValue: c.take("kind") ?? "") ?? .other
        requester = c.take("requester") ?? "An agent"
        title = c.take("title")
        detail = c.list("detail")
        options = c.list("options")
        message = c.take("message")
        fields = c.list("fields")
    }
}

struct ViewFrame: Decodable {
    let sessionId: String
    let participant: String
    let reset: Bool
    let header: Header?
    let rows: [Row]
    let removed: [String]
    let requests: [Request]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        sessionId = try c.decode(String.self, forKey: "sessionId")
        participant = try c.decode(String.self, forKey: "participant")
        reset = c.take("reset") ?? false
        header = c.take("header")
        rows = c.list("rows")
        removed = c.list("removed")
        requests = c.list("requests")
    }
}

struct ResultFrame: Decodable {
    let id: String
    let ok: Bool
    let error: String?
    let feedback: String?
}

enum ServerFrame {
    case sessions(SessionsFrame)
    case view(ViewFrame)
    case result(ResultFrame)

    // Nil for a frame of a type this app does not know, or one it cannot read.
    static func decode(_ data: Data) -> ServerFrame? {
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: data) else { return nil }
        switch envelope.type {
        case "sessions": return (try? decoder.decode(SessionsFrame.self, from: data)).map(Self.sessions)
        case "view": return (try? decoder.decode(ViewFrame.self, from: data)).map(Self.view)
        case "result": return (try? decoder.decode(ResultFrame.self, from: data)).map(Self.result)
        default: return nil
        }
    }

    private struct Envelope: Decodable { let type: String }
}

// Client → server. One shape for every request: the encoder leaves out what
// a type does not carry.
struct ClientFrame: Encodable, Sendable {
    let type: String
    var id = ""
    var sessionId: String?
    var participant: String?
    var text: String?
    var requestId: String?
    var optionId: String?
    var answer: QuestionAnswer?
    var apnsToken: String?
    var environment: String?

    static func subscribe(_ sessionId: String, _ participant: String) -> Self {
        Self(type: "subscribe", sessionId: sessionId, participant: participant)
    }
    static func send(_ sessionId: String, _ participant: String, _ text: String) -> Self {
        Self(type: "send", sessionId: sessionId, participant: participant, text: text)
    }
    static func cancel(_ sessionId: String) -> Self { Self(type: "cancel", sessionId: sessionId) }
    static func approve(_ requestId: String, _ optionId: String) -> Self {
        Self(type: "approve", requestId: requestId, optionId: optionId)
    }
    static func answer(_ requestId: String, _ answer: QuestionAnswer) -> Self {
        Self(type: "answer", requestId: requestId, answer: answer)
    }
    static func device(_ token: String, _ environment: String) -> Self {
        Self(type: "device", apnsToken: token, environment: environment)
    }
}

// questions.ts QuestionAnswer: accept with content, or decline without.
struct QuestionAnswer: Encodable, Sendable {
    let action: String
    let content: [String: AnswerValue]?

    static func accept(_ content: [String: AnswerValue]) -> Self { Self(action: "accept", content: content) }
    static let decline = Self(action: "decline", content: nil)
}

enum AnswerValue: Encodable, Equatable, Sendable {
    case string(String), number(Double), boolean(Bool), strings([String])

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .boolean(let value): try c.encode(value)
        case .strings(let value): try c.encode(value)
        }
    }
}

// Lenient decoding. A key that is missing, null or of the wrong type reads
// as nil; a list keeps the elements that decode and drops the rest.
struct Keys: CodingKey, ExpressibleByStringLiteral {
    let stringValue: String
    init(stringValue: String) { self.stringValue = stringValue }
    init(stringLiteral value: String) { stringValue = value }
    var intValue: Int? { nil }
    init?(intValue: Int) { nil }
}

private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension KeyedDecodingContainer where K == Keys {
    func take<T: Decodable>(_ key: Keys) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }

    func list<T: Decodable>(_ key: Keys) -> [T] {
        ((try? decodeIfPresent([Lossy<T>].self, forKey: key)) ?? nil)?.compactMap(\.value) ?? []
    }
}
