import SwiftUI

/// The floating chat/message input pill — glass on iOS 26, a soft solid on 18.
/// Shared by `ChatView` and `ConversationView` so they stay identical. Two
/// rows, Claude-app style: the caller supplies its own `VStack` — a text row
/// on top, an actions row (attach / mic / send) underneath — rather than
/// this wrapper imposing a layout, since the mention-pill case needs its own
/// row-1 arrangement.
struct ComposerBar<Content: View>: View {
    @ViewBuilder var content: Content
    private let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)

    var body: some View {
        content
        .padding(.horizontal, 12)
        .padding(.top, 9)
        .padding(.bottom, 6)
        .background {
            if #available(iOS 26, *) {
                shape.fill(Color.white.opacity(0.35))
            } else {
                shape.fill(Theme.surface.opacity(0.92))
            }
        }
        .glass(.floating, in: shape)
        .overlay(shape.strokeBorder(.white.opacity(0.5), lineWidth: 1).blendMode(.plusLighter))
        .elevation(Theme.E.pop)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }
}

/// The send / stop button in a composer.
struct SendButton: View {
    let sending: Bool
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: sending ? "stop.fill" : "arrow.up")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(
                    (enabled || sending ? Theme.accent : Theme.textFaint.opacity(0.6)),
                    in: Circle()
                )
                .elevation(enabled || sending ? Theme.E.sm : Theme.Shadow(color: .clear, radius: 0, y: 0))
        }
        .buttonStyle(PressScaleStyle(scale: 0.9))
        .disabled(!enabled && !sending)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: enabled)
    }
}
