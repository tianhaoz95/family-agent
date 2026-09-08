import Foundation
import AVFoundation

/// Plays a `/speak` WAV, one clip at a time, caching by reply text — the iOS
/// mirror of `AppViewModel.speak` / `playWav` / `stopSpeech` (Android). The
/// UI observes `AppModel.speakingText` / `speakLoadingText`.
@MainActor
final class AudioPlayer: NSObject, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var cache: [String: Data] = [:]

    /// Bindings the model exposes to the UI, set by `toggle`.
    var onState: (@MainActor (_ loading: String?, _ playing: String?) -> Void)?

    func toggle(_ text: String, fetch: (String) async throws -> Data) async {
        let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if player?.isPlaying == true {
            stop()
            return
        }
        do {
            let data: Data
            if let cached = cache[key] {
                data = cached
            } else {
                onState?(key, nil)
                data = try await fetch(key)
                cache[key] = data
            }
            onState?(nil, key)
            try configureSession(.playback)
            let p = try AVAudioPlayer(data: data)
            p.delegate = self
            p.prepareToPlay()
            p.play()
            player = p
        } catch {
            onState?(nil, nil)
        }
    }

    func stop() {
        player?.stop()
        player = nil
        onState?(nil, nil)
        try? configureSession(.playAndRecord)
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.stop() }
    }

    private func configureSession(_ category: AVAudioSession.Category) throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(category, mode: .spokenAudio, options: [.duckOthers, .defaultToSpeaker])
        try s.setActive(true, options: [])
    }
}
