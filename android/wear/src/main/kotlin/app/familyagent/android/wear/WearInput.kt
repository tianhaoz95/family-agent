package app.familyagent.android.wear

import android.app.Activity
import android.app.RemoteInput
import android.content.Intent
import androidx.activity.compose.ManagedActivityResultLauncher
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.wear.input.RemoteInputIntentHelper

private const val KEY_TEXT = "text"

/**
 * The composer's "text field" is a tap target, not an editable control — per
 * the product decision for this feature, Wear OS itself decides how a person
 * actually enters text (its own picker offers voice dictation, a scaled-down
 * QWERTY keyboard, handwriting, and smart replies; which of those appear is
 * entirely up to the OS/device, not something this app renders or chooses
 * between). `RemoteInputIntentHelper` is the standard way any Wear app opens
 * that system sheet and gets a plain string back — there's no Compose
 * `TextField` equivalent on Wear the way there is on watchOS (see
 * `ios/FamilyAgentWatch`'s use of a bare SwiftUI `TextField`, which already
 * *is* that OS behavior there).
 */
@Composable
fun rememberWearTextInputLauncher(onResult: (String) -> Unit): ManagedActivityResultLauncher<Intent, ActivityResult> {
    return rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val data = result.data ?: return@rememberLauncherForActivityResult
        val text = RemoteInput.getResultsFromIntent(data)?.getCharSequence(KEY_TEXT)?.toString()
        if (!text.isNullOrBlank()) onResult(text)
    }
}

fun textInputIntent(label: String): Intent {
    val remoteInputs = listOf(RemoteInput.Builder(KEY_TEXT).setLabel(label).build())
    val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
    RemoteInputIntentHelper.putRemoteInputsExtra(intent, remoteInputs)
    return intent
}

/** A no-argument launch helper — most call sites just want "open the picker
 *  with this label", not to hold onto the launcher/intent split themselves. */
@Composable
fun rememberTextInputLauncher(label: String, onResult: (String) -> Unit): () -> Unit {
    val launcher = rememberWearTextInputLauncher(onResult)
    return remember(label) { { launcher.launch(textInputIntent(label)) } }
}
