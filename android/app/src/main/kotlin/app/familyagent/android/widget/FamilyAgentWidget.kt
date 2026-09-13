package app.familyagent.android.widget

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import app.familyagent.android.MainActivity
import app.familyagent.android.R
import app.familyagent.android.WidgetLaunch

/**
 * The home screen widget: a Claude/Gemini-style launcher bar — an
 * input-field-shaped tap target that opens Chat, plus mic and camera buttons
 * that open Chat AND immediately trigger that control (see ChatScreen's
 * `pendingAction` / HoldToTalkMic's `autoStartToken`, which this drives via
 * a plain Intent extra — [WidgetLaunch.EXTRA_ACTION]).
 *
 * No live data, no [androidx.glance.state.GlanceStateDefinition]: this is a
 * static shortcut row, not a dashboard, so there's nothing to refresh and
 * `updatePeriodMillis="0"` in the provider info.
 */
class FamilyAgentWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { WidgetContent() }
    }
}

/** Registers [FamilyAgentWidget] with the launcher — the manifest entry
 *  (`<receiver>`) points here, not at the widget class itself. */
class FamilyAgentWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = FamilyAgentWidget()
}

private fun chatIntent(context: Context, action: String): Intent =
    Intent(context, MainActivity::class.java).apply {
        this.action = Intent.ACTION_VIEW
        // NEW_TASK: this Intent is launched from the launcher's process, not
        // an Activity context, which the framework requires for that. The
        // rest matches ReplyNotifications' nav intent — singleTop reuses a
        // running instance (delivered via onNewIntent) rather than
        // stacking a second one.
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        putExtra(WidgetLaunch.EXTRA_ACTION, action)
    }

private val FieldTextColor = ColorProvider(Color(0xFF6B6B6B))
private val FieldBg = ColorProvider(Color(0xFFF6F5F4))
private val CardBg = ColorProvider(Color(0xFFFFFFFF))

@Composable
private fun WidgetContent() {
    val context = LocalContext.current
    Row(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(CardBg)
            .cornerRadius(24.dp)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(
            provider = ImageProvider(R.drawable.logo),
            contentDescription = "Family Agent",
            modifier = GlanceModifier.size(30.dp),
        )
        Spacer(GlanceModifier.width(10.dp))
        Box(
            modifier = GlanceModifier
                .defaultWeight()
                .height(42.dp)
                .background(FieldBg)
                .cornerRadius(21.dp)
                .padding(horizontal = 14.dp)
                .clickable(actionStartActivity(chatIntent(context, "open"))),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text("Ask Family Agent…", style = TextStyle(color = FieldTextColor, fontSize = 14.sp))
        }
        Spacer(GlanceModifier.width(6.dp))
        WidgetIconButton(R.drawable.ic_widget_mic, "Voice", chatIntent(context, "mic"))
        Spacer(GlanceModifier.width(2.dp))
        WidgetIconButton(R.drawable.ic_widget_camera, "Camera", chatIntent(context, "camera"))
    }
}

@Composable
private fun WidgetIconButton(iconRes: Int, description: String, intent: Intent) {
    Box(
        modifier = GlanceModifier
            .size(42.dp)
            .cornerRadius(21.dp)
            .clickable(actionStartActivity(intent)),
        contentAlignment = Alignment.Center,
    ) {
        Image(provider = ImageProvider(iconRes), contentDescription = description, modifier = GlanceModifier.size(22.dp))
    }
}
