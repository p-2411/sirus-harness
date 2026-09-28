import Foundation

// One Sirus process listening on the Mac. Several processes each take their
// own port in 47470–47479.
struct Endpoint: Hashable, Sendable {
    static let ports = 47470...47479

    let host: String
    let port: Int

    var socketURL: URL? { URL(string: "ws://\(authority)/v1/socket") }
    var helloURL: URL? { URL(string: "http://\(authority)/v1/hello") }
    private var authority: String { host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)" }
}

enum HostScanner {
    enum Failure: LocalizedError {
        case invalid, refused(String), none(String)

        var errorDescription: String? {
            switch self {
            case .invalid: "Enter your Mac's Tailscale name, like mac.tailnet.ts.net."
            case .refused(let host): "\(host) turned this phone away. Sign in to Tailscale on the phone as the same user as the Mac."
            case .none(let host): "No Sirus is listening on \(host). Run /\u{2060}rc in a Sirus session on your Mac, and check Tailscale is on here."
            }
        }

        // A name that was not reached, or that turned the phone away, is
        // almost always Tailscale: off on one side, or signed in as someone
        // else. A name that did not parse is only a typo.
        var concernsTailscale: Bool {
            if case .invalid = self { return false }
            return true
        }
    }

    // What a person might type or paste: a bare name, a URL, a name with a
    // port, or the whole sirus://connect link.
    static func normalize(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URLComponents(string: text), url.scheme == "sirus",
           let host = url.queryItems?.first(where: { $0.name == "host" })?.value {
            text = host
        }
        if let range = text.range(of: "://") { text = String(text[range.upperBound...]) }
        text = String(text.prefix { $0 != "/" && $0 != "?" })
        if text.hasPrefix("[") {
            text = String(text.dropFirst().prefix { $0 != "]" })
        } else if text.filter({ $0 == ":" }).count == 1 {
            text = String(text.prefix { $0 != ":" })
        }
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
        return text.isEmpty || text.contains("@") || text.contains(" ") ? nil : text
    }

    // Probes /v1/hello on every port at once and returns the Sirus processes
    // that answered, in port order.
    static func scan(_ host: String) async throws(Failure) -> [Endpoint] {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3
        configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }

        let answers = await withTaskGroup(of: (Endpoint, Int?).self) { group in
            for port in Endpoint.ports {
                let endpoint = Endpoint(host: host, port: port)
                group.addTask {
                    guard let url = endpoint.helloURL,
                          let (data, response) = try? await session.data(from: url),
                          let status = (response as? HTTPURLResponse)?.statusCode else { return (endpoint, nil) }
                    if status == 200, let hello = try? JSONDecoder().decode(Hello.self, from: data), hello.protocol == 1 {
                        return (endpoint, 200)
                    }
                    return (endpoint, status)
                }
            }
            var answers: [(Endpoint, Int?)] = []
            for await answer in group { answers.append(answer) }
            return answers
        }
        let found = answers.filter { $0.1 == 200 }.map(\.0).sorted { $0.port < $1.port }
        if !found.isEmpty { return found }
        if answers.contains(where: { $0.1 == 403 }) { throw .refused(host) }
        throw .none(host)
    }
}
