@preconcurrency import AVFoundation
import Foundation

/// Records mic audio as 16 kHz mono 16-bit PCM and returns a WAV — the iOS
/// mirror of `android/.../ui/VoiceRecorder.kt`. `amplitude` (0…1, smoothed RMS)
/// drives the push-to-talk waveform, matching the Android constants
/// (`min(1, s*6)`, fast-attack/slow-release).
///
/// The engine tap runs on the audio render thread; it feeds a lock-guarded
/// `Sink`, and amplitude updates hop to the main actor. Public API is used
/// only from the main actor.
@MainActor
final class VoiceRecorder {
    private let engine = AVAudioEngine()
    private let sink = Sink()
    /// Smoothed RMS level (0…1), refreshed ~20×/s while recording. The
    /// push-to-talk overlay's waveform samples this live each frame.
    private(set) var amplitude: Float = 0
    private(set) var isRecording = false
    private var tickTask: Task<Void, Never>?

    static func requestPermission() async -> Bool {
        await withCheckedContinuation { cont in
            AVAudioApplication.requestRecordPermission { cont.resume(returning: $0) }
        }
    }

    func start() throws {
        guard !isRecording else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.duckOthers, .defaultToSpeaker])
        try session.setActive(true)

        sink.reset()
        amplitude = 0

        let input = engine.inputNode
        let inFormat = input.inputFormat(forBus: 0)
        guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                            sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
            throw NSError(domain: "VoiceRecorder", code: 1)
        }
        sink.converter = converter
        sink.outFormat = outFormat

        let sink = self.sink
        // `@Sendable` forces the tap block to be non-isolated. Without it the
        // closure is inferred `@MainActor` (it's formed in a `@MainActor`
        // method and `@preconcurrency import AVFoundation` strips `@Sendable`
        // off `AVAudioNodeTapBlock`), so when the audio render thread invokes
        // it the Swift 6 runtime's executor check traps — EXC_BREAKPOINT in
        // `swift_task_isCurrentExecutor`, seen on the iOS 26 runtime the moment
        // push-to-talk starts recording.
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { @Sendable buffer, _ in
            sink.feed(buffer)
        }
        engine.prepare()
        try engine.start()
        isRecording = true

        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                guard let self else { return }
                self.amplitude = self.sink.currentAmplitude
            }
        }
    }

    func stop() -> Data {
        guard isRecording else { return Data() }
        finish()
        let pcm = sink.drain()
        return pcm.isEmpty ? Data() : WAV.wrap(pcm)
    }

    func cancel() {
        guard isRecording else { return }
        finish()
        _ = sink.drain()
    }

    private func finish() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        amplitude = 0
        tickTask?.cancel()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    /// Lock-guarded PCM accumulator + RMS meter, safe to call from the render thread.
    private final class Sink: @unchecked Sendable {
        private let lock = NSLock()
        private var pcm = Data()
        private var smoothed: Float = 0
        var converter: AVAudioConverter?
        var outFormat: AVAudioFormat?

        func reset() { lock.lock(); pcm.removeAll(); smoothed = 0; lock.unlock() }
        func drain() -> Data { lock.lock(); defer { lock.unlock() }; let d = pcm; pcm = Data(); return d }
        var currentAmplitude: Float { lock.lock(); defer { lock.unlock() }; return min(1, smoothed * 6) }

        func feed(_ buffer: AVAudioPCMBuffer) {
            guard let converter, let outFormat else { return }
            let inRate = buffer.format.sampleRate
            let cap = AVAudioFrameCount(Double(buffer.frameLength) * (16_000.0 / inRate) + 64)
            guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
            let provided = ProvideOnce(buffer)
            var err: NSError?
            converter.convert(to: out, error: &err) { _, status in provided.next(status) }
            guard err == nil, let ch = out.int16ChannelData else { return }
            let n = Int(out.frameLength)
            var sum = 0.0
            var bytes = Data(capacity: n * 2)
            for i in 0..<n {
                let s = ch[0][i]
                withUnsafeBytes(of: s.littleEndian) { bytes.append(contentsOf: $0) }
                let f = Double(s) / 32768.0
                sum += f * f
            }
            let rms = n > 0 ? Float((sum / Double(n)).squareRoot()) : 0
            lock.lock()
            pcm.append(bytes)
            smoothed = rms > smoothed ? rms * 0.6 + smoothed * 0.4 : rms * 0.2 + smoothed * 0.8
            lock.unlock()
        }
    }

    /// One-shot converter input source (avoids a captured mutable `Bool`).
    private final class ProvideOnce: @unchecked Sendable {
        private let buffer: AVAudioPCMBuffer
        private var used = false
        init(_ b: AVAudioPCMBuffer) { buffer = b }
        func next(_ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
            if used { status.pointee = .noDataNow; return nil }
            used = true
            status.pointee = .haveData
            return buffer
        }
    }
}
