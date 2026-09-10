import { describe, it, expect } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import { lanAddrs } from "../src/lan.js";

const nic = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null }) as NetworkInterfaceInfo;

describe("lanAddrs", () => {
  it("classifies and orders tailscale, then LAN, then other; skips loopback / link-local", () => {
    const got = lanAddrs(
      4173,
      {
        lo0: [nic("127.0.0.1", true)],
        en0: [nic("192.168.1.42")],
        utun4: [nic("100.101.102.103")],
        en5: [nic("169.254.10.1")],
        en6: [nic("203.0.113.7")],
      },
      null,
    );
    expect(got).toEqual([
      { url: "http://100.101.102.103:4173", kind: "tailscale" },
      { url: "http://192.168.1.42:4173", kind: "lan" },
      { url: "http://203.0.113.7:4173", kind: "other" },
    ]);
  });

  it("a 100.64/10 address NOT on a tunnel interface is only 'other' (real CGNAT, not Tailscale)", () => {
    expect(lanAddrs(4173, { en0: [nic("100.70.0.5")] }, null)[0].kind).toBe("other");
  });

  it("leads with the MagicDNS name, then the raw Tailscale IP", () => {
    const got = lanAddrs(4173, { utun3: [nic("100.101.102.103")], en0: [nic("192.168.1.42")] }, "mac.tail1234.ts.net");
    expect(got.map((a) => a.url)).toEqual([
      "http://mac.tail1234.ts.net:4173",
      "http://100.101.102.103:4173",
      "http://192.168.1.42:4173",
    ]);
    expect(got[0].kind).toBe("tailscale");
  });

  it("empty when the host has no usable IPv4 and no Tailscale", () => {
    expect(lanAddrs(4173, { lo0: [nic("127.0.0.1", true)] }, null)).toEqual([]);
  });
});
