package app.familyagent.android.ui

import android.Manifest
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.core.content.ContextCompat
import app.familyagent.android.ui.theme.AppAccents
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val BAR_COUNT = 32
private const val HOLD_MS = 320L
private const val CANCEL_SLIDE_PX = 120f

/**
 * The composer's microphone control. Two gestures on one target:
 *  • quick tap → start dictation; tap again to stop; the transcript lands in
 *    the composer for review (never auto-sent) — [onDictate].
 *  • press-and-hold → push-to-talk: [VoiceOverlay] appears, and on release the
 *    clip is transcribed and sent immediately — [onVoiceSend]. Sliding the
 *    finger away past a threshold before releasing cancels it.
 */
@Composable
fun HoldToTalkMic(
    enabled: Boolean,
    transcribing: Boolean,
    recorder: VoiceRecorder,
    onDictate: (ByteArray) -> Unit,
    onVoiceSend: (ByteArray) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val isRecording = remember { mutableStateOf(false) }
    val pttActive = remember { mutableStateOf(false) }
    val cancelArmed = remember { mutableStateOf(false) }
    val amplitude by recorder.amplitude.collectAsState()

    DisposableEffect(Unit) { onDispose { recorder.cancel() } }

    fun hasPermission() = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) runCatching { recorder.start() }.onSuccess { isRecording.value = true }
    }

    fun startDictation() {
        if (isRecording.value) return
        if (!hasPermission()) {
            permLauncher.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        runCatching { recorder.start() }.onSuccess { isRecording.value = true }
    }
    fun stopDictation() {
        if (!isRecording.value) return
        isRecording.value = false
        scope.launch {
            val wav = recorder.stop()
            if (wav.isNotEmpty()) onDictate(wav)
        }
    }
    fun startPtt() {
        if (!hasPermission()) {
            permLauncher.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        runCatching { recorder.start() }.onSuccess {
            isRecording.value = true
            cancelArmed.value = false
            pttActive.value = true
        }
    }
    fun finishPtt(send: Boolean) {
        if (!pttActive.value) return
        pttActive.value = false
        isRecording.value = false
        val armed = cancelArmed.value
        cancelArmed.value = false
        scope.launch {
            if (send && !armed) {
                val wav = recorder.stop()
                if (wav.isNotEmpty()) onVoiceSend(wav)
            } else {
                recorder.cancel()
            }
        }
    }

    if (pttActive.value) VoiceOverlay(amplitude = amplitude, cancelArmed = cancelArmed.value)

    Box(
        modifier
            .size(48.dp)
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    // A dictation is already running: this press is "tap to stop".
                    if (isRecording.value && !pttActive.value) {
                        down.consume()
                        stopDictation()
                        return@awaitEachGesture
                    }
                    var promoted = false
                    val hold = scope.launch {
                        delay(HOLD_MS)
                        promoted = true
                        startPtt()
                    }
                    try {
                        while (true) {
                            val event = awaitPointerEvent()
                            val change = event.changes.firstOrNull { it.id == down.id } ?: continue
                            if (!change.pressed) {
                                if (promoted) change.consume()
                                break
                            }
                            if (promoted && pttActive.value) {
                                val slid = (change.position - down.position).getDistance() > CANCEL_SLIDE_PX
                                if (slid != cancelArmed.value) cancelArmed.value = slid
                            }
                        }
                    } finally {
                        hold.cancel()
                        if (promoted) finishPtt(send = true)
                        else if (!isRecording.value) startDictation()
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        if (transcribing) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        } else {
            Icon(
                if (isRecording.value) Icons.Rounded.Stop else Icons.Rounded.Mic,
                contentDescription = if (isRecording.value) "Stop recording" else "Hold to talk, tap to dictate",
                modifier = Modifier.size(22.dp),
                tint = if (isRecording.value) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            )
        }
    }
}

/**
 * Full-screen "listening" overlay shown while the mic button is held for
 * push-to-talk (see ChatScreen / ConversationScreen). The bars travel
 * right-to-left, each one a past mic level from [amplitude] — reads clearly as
 * "recording now". Turns red once the pointer has slid far enough to cancel.
 *
 * Rendered in a [Popup] (its own window) so it sits above the composer and the
 * keyboard; it carries no pointer modifiers, so the in-flight press-and-hold
 * gesture on the mic button keeps flowing to that button uninterrupted.
 */
@Composable
fun VoiceOverlay(amplitude: Float, cancelArmed: Boolean) {
    val context = LocalContext.current
    val freeze = remember {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }.getOrDefault(false)
    }

    Popup(
        alignment = Alignment.Center,
        properties = PopupProperties(focusable = false),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background.copy(alpha = 0.92f)),
            contentAlignment = Alignment.Center,
        ) {
            val accent = MaterialTheme.colorScheme.primary
            val danger = MaterialTheme.colorScheme.error
            val barColor by animateColorAsState(if (cancelArmed) danger else accent, label = "voiceBar")

            val levels = remember { mutableStateListOf<Float>().apply { repeat(BAR_COUNT) { add(0f) } } }
            val live = rememberUpdatedState(amplitude)
            LaunchedEffect(freeze) {
                if (freeze) {
                    for (i in 0 until BAR_COUNT) levels[i] = 0.3f
                    return@LaunchedEffect
                }
                while (true) {
                    levels.removeAt(0)
                    levels.add(live.value.coerceIn(0f, 1f))
                    delay(55)
                }
            }

            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Row(
                    Modifier.height(120.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    for (lvl in levels) {
                        Box(
                            Modifier
                                .width(6.dp)
                                .height((6f + lvl * 96f).dp)
                                .clip(RoundedCornerShape(3.dp))
                                .background(barColor),
                        )
                    }
                }
                Spacer(Modifier.height(24.dp))
                Text(
                    if (cancelArmed) "Release to cancel" else "Listening…",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = if (cancelArmed) danger else MaterialTheme.colorScheme.onBackground,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    "Release to send · slide away to cancel",
                    style = MaterialTheme.typography.bodySmall,
                    color = AppAccents.textSecondary,
                )
            }
        }
    }
}
