package app.familyagent.android.data

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/**
 * This device's own location, for the assistant's get_current_location tool
 * (agent-core) — requested only when Settings → "Let the assistant use my
 * location" is on and only for a Chat send (never a family Messages send).
 * The Android mirror of iOS's App/LocationProvider.swift.
 *
 * Plain LocationManager, not FusedLocationProviderClient — this app has no
 * other Play Services dependency, and ACCESS_COARSE_LOCATION (city-block,
 * not turn-by-turn) is plenty for "state parks near me".
 */
class LocationProvider(private val context: Context) {
    private var cached: Pair<Location, Long>? = null // fix, capturedAtMs

    fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** Returns a location for the current chat turn, or null if permission
     *  isn't granted, no provider is enabled, or nothing arrived within the
     *  timeout. Never throws — every failure mode collapses to null, which
     *  get_current_location degrades to the same "not available" reply for. */
    suspend fun currentLocation(): Location? {
        val now = System.currentTimeMillis()
        cached?.let { (loc, capturedAt) -> if (now - capturedAt < CACHE_MS) return loc }
        if (!hasPermission()) return null

        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        val provider = listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
            .firstOrNull { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
            ?: return null

        val fix = withTimeoutOrNull(TIMEOUT_MS) {
            suspendCancellableCoroutine<Location?> { cont ->
                val listener = object : LocationListener {
                    override fun onLocationChanged(location: Location) {
                        manager.removeUpdates(this)
                        // resumeWith, not resume(value) — CancellableContinuation's own
                        // `resume(value, onCancellation)` member shadows the plain
                        // Continuation extension and (in this coroutines version) has
                        // no default for onCancellation. resumeWith is unambiguous.
                        if (cont.isActive) cont.resumeWith(Result.success(location))
                    }
                }
                try {
                    // Deprecated in favor of getCurrentLocation (API 30+) — this app's
                    // minSdk is 26, so this is the broadly-compatible choice, same
                    // tradeoff already made in ServerDiscovery.kt.
                    @Suppress("DEPRECATION")
                    manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
                } catch (e: SecurityException) {
                    if (cont.isActive) cont.resumeWith(Result.success(null))
                    return@suspendCancellableCoroutine
                }
                cont.invokeOnCancellation { manager.removeUpdates(listener) }
            }
        }
        if (fix != null) cached = fix to now
        return fix
    }

    companion object {
        private const val CACHE_MS = 3 * 60 * 1000L
        private const val TIMEOUT_MS = 8000L
    }
}
