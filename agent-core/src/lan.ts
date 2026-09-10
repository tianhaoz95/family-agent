import * as os from "node:os";
import { networkInterfaces } from "node:os";
import { execFile } from "node:child_process";

export type LanAddr = {
  /** `http://<host>:<port>` */
  url: string;
  /** `tailscale` (100.64/10 iface or a MagicDNS name), `lan` (RFC1918), or `other`. */
  kind: "tailscale" | "lan" | "other";
};

function isCgnat(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}
function isPrivate(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * This machine's reachable base URLs, for the "Pair a phone" QR / address list
 * on the desktop. Skips loopback / internal / link-local (169.254.x).
 *
 * **Tailscale first.** The address most likely to actually reach the phone: it
 * works whether or not the phone is on the home Wi-Fi. When the Tailscale CLI is
 * reachable we lead with the MagicDNS name (stable across IP changes, and what
 * you'd type by hand); the raw `100.x` IP follows for tailnets with MagicDNS
 * off. Plain LAN (RFC1918) comes next, then anything else.
 */
export function lanAddrs(
  port: number,
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = networkInterfaces(),
  magicDnsName: string | null = tailscaleMagicDnsName(),
): LanAddr[] {
  const seen = new Set<string>();
  const out: LanAddr[] = [];
  if (magicDnsName) {
    out.push({ url: `http://${magicDnsName}:${port}`, kind: "tailscale" });
    seen.add(magicDnsName);
  }
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue;
      if (seen.has(a.address)) continue;
      seen.add(a.address);
      const tunnel = /^(utun|tailscale|ts)/i.test(name);
      const kind: LanAddr["kind"] = isCgnat(a.address) && tunnel
        ? "tailscale"
        : isPrivate(a.address)
          ? "lan"
          : "other";
      out.push({ url: `http://${a.address}:${port}`, kind });
    }
  }
  const rank = (k: LanAddr["kind"]) => (k === "tailscale" ? 0 : k === "lan" ? 1 : 2);
  // Stable sort keeps the MagicDNS name ahead of the raw Tailscale IP.
  return out.map((v, i) => ({ v, i })).sort((x, y) => rank(x.v.kind) - rank(y.v.kind) || x.i - y.i).map((e) => e.v);
}

// --- Tailscale MagicDNS name (best-effort, cached) --------------------------
//
// `tailscale status --json` → `.Self.DNSName` (a trailing-dot FQDN). The binary
// isn't on PATH on macOS (it lives inside the .app), so try the usual spots.
// Anything unexpected → null; this is a nice-to-have, never a hard dependency.

const TS_BINS = [
  "tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

let magicDnsCache: { name: string | null; at: number } | undefined;
const MAGIC_DNS_TTL_MS = 60_000;

/** Synchronous accessor: returns the last resolved name, kicks off a refresh. */
export function tailscaleMagicDnsName(): string | null {
  const now = Date.now();
  if (!magicDnsCache || now - magicDnsCache.at > MAGIC_DNS_TTL_MS) {
    if (!magicDnsCache) magicDnsCache = { name: null, at: 0 };
    magicDnsCache.at = now; // debounce concurrent refreshes
    void refreshMagicDnsName();
  }
  return magicDnsCache.name;
}

async function refreshMagicDnsName(): Promise<void> {
  for (const bin of TS_BINS) {
    try {
      const name = await new Promise<string | null>((resolve) => {
        execFile(bin, ["status", "--json"], { timeout: 2500 }, (err, stdout) => {
          if (err) return resolve(null);
          try {
            const dns = JSON.parse(stdout)?.Self?.DNSName;
            resolve(typeof dns === "string" && dns ? dns.replace(/\.$/, "") : null);
          } catch {
            resolve(null);
          }
        });
      });
      if (name) {
        magicDnsCache = { name, at: Date.now() };
        return;
      }
    } catch {
      // try the next path
    }
  }
  magicDnsCache = { name: null, at: Date.now() };
}
