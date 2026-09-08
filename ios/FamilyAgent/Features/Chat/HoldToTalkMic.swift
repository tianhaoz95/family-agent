import SwiftUI

/// The composer mic control — quick tap dictates into the field; press-and-hold
/// is push-to-talk (auto-send + speak the reply). Slide away to cancel.
/// Mirrors `android/.../ui/VoiceOverlay.kt`'s `HoldToTalkMic`.
struct HoldToTalkMic: View {
    let enabled: Bool
    let transcribing: Bool
    /// dictation: transcript comes back for review
    let onDictate: (Data) -> Void
    /// push-to-talk: clip is sent immediately
    let onVoiceSend: (Data) -> Void

    @State private var recorder = VoiceRecorder()
    @State private var mode: Mode = .idle
    @State private var amplitude: Float = 0
    @State private var cancelArmed = false
    @State private var holdTask: Task<Void, Never>?

    private enum Mode { case idle, dictating, ptt }

    var body: some View {
        Image(systemName: mode == .idle ? "mic" : "stop.fill")
            .font(.system(size: 18))
            .foregroundStyle(mode == .idle ? Theme.accentInk : Theme.danger)
            .frame(width: 36, height: 36)
            .contentShape(Rectangle())
            .overlay {
                if transcribing { ProgressView().controlSize(.small) }
            }
            .gesture(pressGesture)
            .disabled(!enabled)
            .fullScreenCover(isPresented: Binding(get: { mode == .ptt }, set: { _ in })) {
                VoiceOverlay(amplitude: amplitude, cancelArmed: cancelArmed)
                    .presentationBackground(.clear)
            }
    }

    private var pressGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.32)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .onChanged { value in
                switch value {
                case .first(true):
                    // long-press recognised → begin PTT
                    beginPTT()
                case .second(true, let drag?):
                    let slid = hypot(drag.translation.width, drag.translation.height) > 120
                    if slid != cancelArmed { cancelArmed = slid }
                default:
                    break
                }
            }
            .onEnded { _ in
                if mode == .ptt { finishPTT() }
            }
            .exclusively(before: TapGesture().onEnded { toggleDictation() })
    }

    private func beginPTT() {
        guard mode == .idle else { return }
        Task {
            guard await VoiceRecorder.requestPermission() else { return }
            do {
                recorder.onAmplitude = { amplitude = $0 }
                try recorder.start()
                mode = .ptt
                cancelArmed = false
            } catch {}
        }
    }
    private func finishPTT() {
        let wav = recorder.stop()
        let armed = cancelArmed
        mode = .idle
        cancelArmed = false
        if !armed, !wav.isEmpty { onVoiceSend(wav) }
    }

    private func toggleDictation() {
        switch mode {
        case .dictating:
            let wav = recorder.stop()
            mode = .idle
            if !wav.isEmpty { onDictate(wav) }
        case .idle:
            Task {
                guard await VoiceRecorder.requestPermission() else { return }
                do {
                    recorder.onAmplitude = { amplitude = $0 }
                    try recorder.start()
                    mode = .dictating
                } catch {}
            }
        case .ptt:
            break
        }
    }
}

/// Full-screen "listening" overlay — 32 bars scrolling right-to-left.
struct VoiceOverlay: View {
    let amplitude: Float
    let cancelArmed: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var levels = [Float](repeating: 0, count: 32)

    var body: some View {
        ZStack {
            Rectangle().fill(.regularMaterial).ignoresSafeArea()
            VStack(spacing: 24) {
                HStack(spacing: 5) {
                    ForEach(levels.indices, id: \.self) { i in
                        RoundedRectangle(cornerRadius: 3)
                            .fill(cancelArmed ? Theme.danger : Theme.accent)
                            .frame(width: 6, height: CGFloat(6 + levels[i] * 96))
                    }
                }
                .frame(height: 120)
                Text(cancelArmed ? "Release to cancel" : "Listening…")
                    .font(.inter(17, .semibold))
                    .foregroundStyle(cancelArmed ? Theme.danger : Theme.text)
                Text("Release to send · slide away to cancel")
                    .appBodySmall().foregroundStyle(Theme.textMuted)
            }
        }
        .task {
            if reduceMotion { levels = [Float](repeating: 0.3, count: 32); return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(55))
                levels.removeFirst()
                levels.append(min(1, max(0, amplitude)))
            }
        }
    }
}
