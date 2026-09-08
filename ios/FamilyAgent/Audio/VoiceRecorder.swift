import Foundation
import AVFoundation

/// Records mic audio as 16 kHz mono 16-bit PCM and returns a WAV — the iOS
/// mirror of `android/.../ui/VoiceRecorder.kt`. `amplitude` (0…1, smoothed RMS)
/// drives the push-to-talk waveform, matching the Android constants
/// (`min(1, s*6)`, fast-attack/slow-release).
///
/// Confined to main-actor use; the tap callback is self-contained.
@MainActor
final class VoiceRecorder {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var pcm = Data()
    private var smoothed: Float = 0
    private(set) var amplitude: Float = 0
    private(set) var isRecording = false

    /// Called on the main actor each time `amplitude` updates.
    var onAmplitude: ((Float) -> Void)?

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

        pcm.removeAll(keepingCapacity: true)
        smoothed = 0
        amplitude = 0

        let input = engine.inputNode
        let inFormat = input.inputFormat(forBus: 0)
        guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                            sampleRate: 16_000, channels: 1, interleaved: true) else {
            throw NSError(domain: "VoiceRecorder", code: 1)
        }
        converter = AVAudioConverter(from: inFormat, to: outFormat)

        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
            guard let self, let converter = self.converterRef else { return }
            let ratio = 16_000.0 / inFormat.sampleRate
            let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
            guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
            var fed = false
            var err: NSError?
            converter.convert(to: out, error: &err) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            if err != nil { return }
            self.consume(out)
        }
        engine.prepare()
        try engine.start()
        isRecording = true
    }

    private var converterRef: AVAudioConverter? { converter }

    private nonisolated func consume(_ out: AVAudioPCMBuffer) {
        guard let ch = out.int16ChannelData else { return }
        let n = Int(out.frameLength)
        let samples = ch[0]
        var sum: Double = 0
        var bytes = Data(capacity: n * 2)
        for i in 0..<n {
            let s = samples[i]
            withUnsafeBytes(of: s.littleEndian) { bytes.append(contentsOf: $0) }
            let f = Double(s) / 32768.0
            sum += f * f
        }
        let rms = n > 0 ? Float(sqrt(sum / Double(n))) : 0
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.pcm.append(bytes)
            self.smoothed = rms > self.smoothed
                ? rms * 0.6 + self.smoothed * 0.4
                : rms * 0.2 + self.smoothed * 0.8
            self.amplitude = min(1, self.smoothed * 6)
            self.onAmplitude?(self.amplitude)
        }
    }

    func stop() -> Data {
        guard isRecording else { return Data() }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        amplitude = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        return pcm.isEmpty ? Data() : WAV.wrap(pcm)
    }

    func cancel() {
        guard isRecording else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        amplitude = 0
        pcm.removeAll()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
