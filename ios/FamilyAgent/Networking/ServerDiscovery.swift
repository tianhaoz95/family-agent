import Foundation
import Network

/// A Family Agent master node found on the local network.
struct DiscoveredServer: Identifiable, Hashable, Sendable {
    let name: String
    let host: String
    let port: Int
    var id: String { "\(host):\(port)" }
    var url: String { "http://\(host):\(port)" }
}

/// Finds home servers two ways at once — Bonjour (`_familyagent._tcp`) and an
/// active `GET /health` probe of the device's own /24 (plus `localhost` on the
/// simulator, which shares the Mac's network). Mirrors
/// `android/.../data/ServerDiscovery.kt`. Requires `NSBonjourServices` +
/// `NSLocalNetworkUsageDescription` in Info.plist.
final class ServerDiscovery: Sendable {
    static let defaultPort = 4173
    static let serviceType = "_familyagent._tcp"

    #if targetEnvironment(simulator)
    static let manualEntryDefault = "http://localhost:\(defaultPort)"
    #else
    static let manualEntryDefault = "http://192.168.1.10:\(defaultPort)"
    #endif

    /// An `AsyncStream` of the current best-known set, updated as servers come and go.
    func discover() -> AsyncStream<[DiscoveredServer]> {
        AsyncStream { continuation in
            let box = FoundBox()

            // 1. Bonjour.
            let browser = NWBrowser(
                for: .bonjour(type: Self.serviceType, domain: nil),
                using: .init()
            )
            browser.browseResultsChangedHandler = { results, _ in
                for result in results {
                    if case let .service(name, _, _, _) = result.endpoint {
                        Task {
                            if let s = await Self.resolveBonjour(result.endpoint, fallbackName: name) {
                                await box.insert(s)
                                continuation.yield(await box.sorted())
                            }
                        }
                    }
                }
            }
            browser.start(queue: .global(qos: .userInitiated))

            // 2. Active /24 probe (+ localhost on sim).
            let probeTask = Task {
                var hosts: [String] = []
                #if targetEnvironment(simulator)
                hosts.append("localhost")
                hosts.append("127.0.0.1")
                #endif
                hosts.append(contentsOf: Self.localSubnetHosts())
                await withTaskGroup(of: DiscoveredServer?.self) { group in
                    let sem = AsyncSemaphore(limit: 40)
                    for host in hosts {
                        group.addTask {
                            await sem.wait()
                            defer { Task { await sem.signal() } }
                            return await Self.probe(host: host, port: Self.defaultPort)
                        }
                    }
                    for await result in group {
                        if let s = result {
                            await box.insert(s)
                            continuation.yield(await box.sorted())
                        }
                    }
                }
            }

            continuation.onTermination = { _ in
                browser.cancel()
                probeTask.cancel()
            }
        }
    }

    // MARK: - internals

    private actor FoundBox {
        private var items: [String: DiscoveredServer] = [:]
        func insert(_ s: DiscoveredServer) { items[s.id] = s }
        func sorted() -> [DiscoveredServer] {
            items.values.sorted { $0.name.lowercased() < $1.name.lowercased() }
        }
    }

    private static func probe(host: String, port: Int) async -> DiscoveredServer? {
        guard let url = URL(string: "http://\(host):\(port)/health") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.2
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 1.2
        cfg.timeoutIntervalForResource = 1.5
        let session = URLSession(configuration: cfg)
        guard let (data, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let health = try? JSONDecoder().decode(HealthResponse.self, from: data),
              health.ok else { return nil }
        return DiscoveredServer(name: health.serverName, host: host, port: port)
    }

    /// One-shot guarded continuation resumer (Swift 6-safe capture).
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var fired = false
        func run(_ block: () -> Void) {
            lock.lock(); defer { lock.unlock() }
            guard !fired else { return }
            fired = true
            block()
        }
    }

    private static func resolveBonjour(_ endpoint: NWEndpoint, fallbackName: String) async -> DiscoveredServer? {
        await withCheckedContinuation { cont in
            let conn = NWConnection(to: endpoint, using: .tcp)
            let once = Once()
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if let path = conn.currentPath, let remote = path.remoteEndpoint,
                       case let .hostPort(host, port) = remote {
                        let h: String
                        switch host {
                        case .ipv4(let a): h = "\(a)".components(separatedBy: "%").first ?? "\(a)"
                        case .ipv6(let a): h = "\(a)".components(separatedBy: "%").first ?? "\(a)"
                        case .name(let n, _): h = n
                        @unknown default: h = "\(host)"
                        }
                        conn.cancel()
                        once.run { cont.resume(returning: DiscoveredServer(name: fallbackName, host: h, port: Int(port.rawValue))) }
                    }
                case .failed, .cancelled:
                    once.run { cont.resume(returning: nil) }
                default:
                    break
                }
            }
            conn.start(queue: .global())
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                conn.cancel()
                once.run { cont.resume(returning: nil) }
            }
        }
    }

    /// This device's own IPv4 /24 (last octet 1…254, excluding self).
    private static func localSubnetHosts() -> [String] {
        var hosts: [String] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0 else { return hosts }
        defer { freeifaddrs(ifaddr) }
        var ptr = ifaddr
        while let addr = ptr {
            defer { ptr = addr.pointee.ifa_next }
            let flags = Int32(addr.pointee.ifa_flags)
            guard (flags & IFF_UP) == IFF_UP, (flags & IFF_LOOPBACK) == 0,
                  let sa = addr.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            var hostBuf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(sa, socklen_t(sa.pointee.sa_len), &hostBuf, socklen_t(hostBuf.count), nil, 0, NI_NUMERICHOST)
            let ip = String(decoding: hostBuf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            guard ip.hasPrefix("192.168.") || ip.hasPrefix("10.") || ip.hasPrefix("172.") else { continue }
            let parts = ip.split(separator: ".")
            guard parts.count == 4, let selfLast = Int(parts[3]) else { continue }
            let prefix = parts[0...2].joined(separator: ".")
            for last in 1...254 where last != selfLast {
                hosts.append("\(prefix).\(last)")
            }
        }
        return hosts
    }
}

/// Minimal counting semaphore for bounding the probe fan-out.
actor AsyncSemaphore {
    private var count: Int
    private var waiters: [CheckedContinuation<Void, Never>] = []
    init(limit: Int) { count = limit }
    func wait() async {
        if count > 0 { count -= 1; return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func signal() {
        if let w = waiters.first { waiters.removeFirst(); w.resume() }
        else { count += 1 }
    }
}
