import Foundation

enum WAV {
    /// Wrap 16-bit LE mono PCM in a 44-byte RIFF/WAVE header — matches
    /// `VoiceRecorder.kt`'s `wrapWav` and what agent-core's `/transcribe` expects.
    static func wrap(_ pcm: Data, sampleRate: Int = 16_000) -> Data {
        let channels = 1, bitsPerSample = 16
        let byteRate = sampleRate * channels * bitsPerSample / 8
        var h = Data()
        func str(_ s: String) { h.append(s.data(using: .ascii)!) }
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { h.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { h.append(contentsOf: $0) } }
        str("RIFF"); u32(UInt32(36 + pcm.count)); str("WAVE")
        str("fmt "); u32(16); u16(1); u16(UInt16(channels))
        u32(UInt32(sampleRate)); u32(UInt32(byteRate))
        u16(UInt16(channels * bitsPerSample / 8)); u16(UInt16(bitsPerSample))
        str("data"); u32(UInt32(pcm.count))
        return h + pcm
    }
}
