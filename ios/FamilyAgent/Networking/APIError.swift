import Foundation

/// Mirrors the Kotlin `ApiException` / `UnauthorizedException`.
enum APIError: LocalizedError, Sendable {
    /// The server rejected our token — drop back to sign-in.
    case unauthorized
    /// Any other non-2xx, with a message safe to show the user.
    case http(status: Int, message: String)
    /// Transport / decode failure.
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Your session has expired. Sign in again."
        case .http(_, let message):
            return message
        case .transport(let message):
            return message
        }
    }
}
