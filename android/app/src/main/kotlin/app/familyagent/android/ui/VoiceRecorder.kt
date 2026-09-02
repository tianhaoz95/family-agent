package app.familyagent.android.ui

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Records mic audio as 16 kHz mono 16-bit PCM and hands back a WAV byte array —
 * exactly the format agent-core's /transcribe expects, so the server side stays
 * a plain WAV header parse with no audio-codec dependency.
 *
 * AudioRecord (not MediaRecorder) because we want raw PCM at a known rate, not
 * a compressed container we'd have to transcode.
 */
class VoiceRecorder {
    private val sampleRate = 16_000
    private val channelConfig = AudioFormat.CHANNEL_IN_MONO
    private val audioFormat = AudioFormat.ENCODING_PCM_16BIT

    @Volatile private var recording = false
    private var record: AudioRecord? = null
    private val pcm = ByteArrayOutputStream()

    val isRecording: Boolean get() = recording

    /** Caller must hold RECORD_AUDIO. Throws IllegalStateException if the mic won't open. */
    @SuppressLint("MissingPermission")
    fun start() {
        if (recording) return
        val minBuf = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        require(minBuf > 0) { "This device can't record 16 kHz mono PCM." }
        val bufferSize = minBuf * 2
        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            sampleRate,
            channelConfig,
            audioFormat,
            bufferSize,
        )
        check(rec.state == AudioRecord.STATE_INITIALIZED) { "Microphone unavailable." }
        pcm.reset()
        record = rec
        recording = true
        rec.startRecording()
        Thread {
            val chunk = ByteArray(bufferSize)
            while (recording) {
                val n = rec.read(chunk, 0, chunk.size)
                if (n > 0) synchronized(pcm) { pcm.write(chunk, 0, n) }
            }
        }.also { it.isDaemon = true }.start()
    }

    /** Stop and return the recording as a WAV byte array (empty if nothing captured). */
    suspend fun stop(): ByteArray = withContext(Dispatchers.IO) {
        if (!recording) return@withContext ByteArray(0)
        recording = false
        record?.run {
            runCatching { stop() }
            release()
        }
        record = null
        // Let the reader thread drain its last chunk.
        Thread.sleep(60)
        val data = synchronized(pcm) { pcm.toByteArray() }
        if (data.isEmpty()) ByteArray(0) else wrapWav(data, sampleRate)
    }

    /** Abandon the recording and free the mic. */
    fun cancel() {
        recording = false
        record?.run {
            runCatching { stop() }
            release()
        }
        record = null
        pcm.reset()
    }

    private fun wrapWav(pcmData: ByteArray, rate: Int): ByteArray {
        val channels = 1
        val bitsPerSample = 16
        val byteRate = rate * channels * bitsPerSample / 8
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray(Charsets.US_ASCII))
        header.putInt(36 + pcmData.size)
        header.put("WAVE".toByteArray(Charsets.US_ASCII))
        header.put("fmt ".toByteArray(Charsets.US_ASCII))
        header.putInt(16)
        header.putShort(1) // PCM
        header.putShort(channels.toShort())
        header.putInt(rate)
        header.putInt(byteRate)
        header.putShort((channels * bitsPerSample / 8).toShort()) // block align
        header.putShort(bitsPerSample.toShort())
        header.put("data".toByteArray(Charsets.US_ASCII))
        header.putInt(pcmData.size)
        return header.array() + pcmData
    }
}
