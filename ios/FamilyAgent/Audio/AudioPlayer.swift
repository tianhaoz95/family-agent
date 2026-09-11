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
            try configureSession(.playback)
            let p = try AVAudioPlayer(data: data)
            p.delegate = self
            p.prepareToPlay()
            guard p.play() else { throw AudioError.playbackFailed }
            player = p
            onState?(nil, key)
        } catch {
            player = nil
            onState?(nil, nil)
            try? configureSession(.playAndRecord)
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
        // `.defaultToSpeaker` is only legal with `.playAndRecord` — passing it with
        // `.playback` makes `setCategory` throw, which used to be swallowed by the
        // catch in `toggle`, so the reply fetched but never played a sound.
        let options: AVAudioSession.CategoryOptions =
            category == .playAndRecord ? [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP] : [.duckOthers]
        try s.setCategory(category, mode: .spokenAudio, options: options)
        try s.setActive(true, options: [])
    }
}

private enum AudioError: Error { case playbackFailed }
