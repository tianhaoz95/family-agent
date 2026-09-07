import { describe, it, expect } from "vitest";
import { isPrivateAddress, fetchPage, WebFetchError } from "../src/web/fetch.js";

describe("isPrivateAddress", () => {
  it("flags loopback / private / link-local / CGNAT", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
  it("refuses a non-IP string", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("fetchPage SSRF guard", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(fetchPage("file:///etc/passwd")).rejects.toBeInstanceOf(WebFetchError);
    await expect(fetchPage("ftp://example.com")).rejects.toBeInstanceOf(WebFetchError);
  });
  it("rejects a literal private IP", async () => {
    await expect(fetchPage("http://127.0.0.1/health")).rejects.toThrow(/private/i);
    await expect(fetchPage("http://10.0.0.1/x")).rejects.toThrow(/private/i);
    await expect(fetchPage("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private/i);
  });
  it("rejects localhost and .local hostnames without a DNS round-trip", async () => {
    await expect(fetchPage("http://localhost:8080/")).rejects.toThrow(/private|internal/i);
    await expect(fetchPage("http://printer.local/")).rejects.toThrow(/private|internal/i);
  });
  it("rejects a disallowed port", async () => {
    await expect(fetchPage("http://example.com:22/")).rejects.toThrow(/port/i);
  });
});
