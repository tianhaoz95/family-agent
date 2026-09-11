package app.familyagent.android.data

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** A Family Agent master node found on the local network. */
data class DiscoveredServer(val name: String, val host: String, val port: Int) {
    val url: String get() = "http://$host:$port"
}

/** A server this device connected to before — see SettingsStore.recentServers. */
@kotlinx.serialization.Serializable
data class RecentServer(val name: String, val url: String)

// agent-core advertises `_familyagent._tcp` (see agent-core/src/server.ts,
// bonjour-service). NsdManager is the framework's mDNS/DNS-SD client.
//
// BUT: the Android emulator does not forward multicast to the host LAN, so
// NsdManager finds nothing there — and some home/office Wi-Fi blocks mDNS
// between clients too. So alongside mDNS we ALSO actively probe likely
// addresses (this device's own /24, plus 10.0.2.2 which is the emulator's
// alias for the host machine) by hitting GET /health. Anything that answers
// with a Family Agent health payload is listed.
private const val SERVICE_TYPE = "_familyagent._tcp."
private const val DEFAULT_PORT = 4173
private const val EMULATOR_HOST_ALIAS = "10.0.2.2"

class ServerDiscovery(context: Context) {
    private val appContext = context.applicationContext
    private val nsd = appContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val wifi = appContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val probeJson = Json { ignoreUnknownKeys = true }
    private val probeClient = OkHttpClient.Builder()
        .connectTimeout(600, TimeUnit.MILLISECONDS)
        .readTimeout(1200, TimeUnit.MILLISECONDS)
        .build()

    /**
     * Emits the current set of discovered servers, updating as they come and
     * go. Collect it from a screen; all discovery stops when collection stops.
     */
    fun discover(): Flow<List<DiscoveredServer>> = callbackFlow {
        val found = ConcurrentHashMap<String, DiscoveredServer>()
        fun key(host: String, port: Int) = "$host:$port"
        fun emit() = trySend(found.values.sortedBy { it.name.lowercase() })

        // --- 1. mDNS (real devices on permissive networks) ---
        val multicastLock = wifi.createMulticastLock("familyagent-discovery").apply {
            setReferenceCounted(true)
            runCatching { acquire() }
        }
        val resolveListener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                @Suppress("DEPRECATION")
                val host = serviceInfo.host?.hostAddress ?: return
                found[key(host, serviceInfo.port)] =
                    DiscoveredServer(serviceInfo.serviceName, host, serviceInfo.port)
                emit()
            }
        }
        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                @Suppress("DEPRECATION")
                runCatching { nsd.resolveService(serviceInfo, resolveListener) }
            }
            override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
        }
        runCatching { nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener) }

        // --- 2. Active probe fallback (emulator + mDNS-blocked networks) ---
        val probeJob = launch(Dispatchers.IO) {
            val gate = Semaphore(40)
            candidateHosts().map { host ->
                async {
                    gate.withPermit {
                        probe(host, DEFAULT_PORT)?.let {
                            found[key(host, DEFAULT_PORT)] = it
                            emit()
                        }
                    }
                }
            }.awaitAll()
        }

        awaitClose {
            runCatching { nsd.stopServiceDiscovery(discoveryListener) }
            runCatching { if (multicastLock.isHeld) multicastLock.release() }
            probeJob.cancel()
        }
    }

    /** Hosts worth trying: 10.0.2.2 (emulator→host), and this device's own /24. */
    private fun candidateHosts(): List<String> {
        val hosts = linkedSetOf(EMULATOR_HOST_ALIAS)
        localIpv4Addresses().forEach { ip ->
            val prefix = ip.substringBeforeLast('.')
            val self = ip.substringAfterLast('.').toIntOrNull()
            for (last in 1..254) {
                if (last != self) hosts.add("$prefix.$last")
            }
        }
        return hosts.toList()
    }

    private fun localIpv4Addresses(): List<String> = runCatching {
        NetworkInterface.getNetworkInterfaces().asSequence()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.asSequence() }
            .filterIsInstance<Inet4Address>()
            .filter { it.isSiteLocalAddress }
            .mapNotNull { it.hostAddress }
            .toList()
    }.getOrDefault(emptyList())

    private fun probe(host: String, port: Int): DiscoveredServer? = runCatching {
        val req = Request.Builder().url("http://$host:$port/health").get().build()
        probeClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val health = probeJson.decodeFromString<HealthResponse>(resp.body?.string().orEmpty())
            if (!health.ok) return null
            DiscoveredServer(health.serverName, host, port)
        }
    }.getOrNull()

    companion object {
        /**
         * True when this device has a Tailscale-shaped address (100.64.0.0/10
         * — Tailscale's whole tailnet lives in this CGNAT/RFC 6598 block, which
         * `Inet4Address.isSiteLocalAddress` does NOT cover, unlike 10./172.16./
         * 192.168.) on any interface. mDNS relies on link-local multicast,
         * which a tailnet's point-to-point mesh doesn't relay, and the /24
         * probe above only ever covers a real local subnet — so when this is
         * true, automatic discovery can only find a server on the SAME Wi-Fi
         * as this device, never one reachable purely over Tailscale. Used to
         * show an accurate hint instead of a scan that silently can't work.
         */
        fun tailscaleLikelyActive(): Boolean = runCatching {
            NetworkInterface.getNetworkInterfaces().asSequence()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.asSequence() }
                .filterIsInstance<Inet4Address>()
                .any { addr ->
                    val parts = addr.hostAddress?.split(".")?.mapNotNull { it.toIntOrNull() }
                    parts != null && parts.size == 4 && parts[0] == 100 && parts[1] in 64..127
                }
        }.getOrDefault(false)

        /** True on a stock Android emulator — used to pick a sensible manual-entry default. */
        val isEmulator: Boolean by lazy {
            Build.FINGERPRINT.contains("generic", true) ||
                Build.FINGERPRINT.contains("emulator", true) ||
                Build.MODEL.contains("sdk", true) ||
                Build.MODEL.contains("emulator", true) ||
                Build.PRODUCT.contains("sdk", true) ||
                Build.HARDWARE.contains("goldfish", true) ||
                Build.HARDWARE.contains("ranchu", true)
        }

        /** Default address for the manual-entry field. */
        val manualEntryDefault: String
            get() = if (isEmulator) "http://$EMULATOR_HOST_ALIAS:$DEFAULT_PORT" else DEFAULT_SERVER_URL
    }
}
