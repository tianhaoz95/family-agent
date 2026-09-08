import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { VaultKeyring } from "../src/vault/keyring.js";
import { VaultService, VaultLockedError } from "../src/vault/service.js";
import {
  aeadDecrypt,
  aeadEncrypt,
  AAD,
  deriveWrappingKey,
  newDataKey,
  newKeyPair,
  newRecoveryCode,
  newSalt,
  normalizeRecoveryCode,
  sealTo,
  unseal,
  unwrapKey,
  wrapKey,
} from "../src/vault/crypto.js";
import {
  base32Decode,
  generateTotp,
  normalizeTotpInput,
  parseOtpauthUri,
} from "../src/vault/totp.js";

describe("vault/crypto", () => {
  it("AES-GCM round-trips and rejects the wrong key / tampering", () => {
    const key = newDataKey();
    const blob = aeadEncrypt(key, Buffer.from("hunter2"), AAD.entry);
    expect(aeadDecrypt(key, blob, AAD.entry).toString()).toBe("hunter2");
    expect(() => aeadDecrypt(newDataKey(), blob, AAD.entry)).toThrow();
    expect(() => aeadDecrypt(key, blob, AAD.wrap)).toThrow(); // wrong AAD
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => aeadDecrypt(key, tampered, AAD.entry)).toThrow();
  });

  it("key wrap: a wrong wrapping key fails to unwrap (this is the bad-password check)", () => {
    const salt = newSalt();
    const dek = newDataKey();
    const good = deriveWrappingKey("correct horse", salt);
    const wrapped = wrapKey(good, dek);
    expect(unwrapKey(good, wrapped).equals(dek)).toBe(true);
    const bad = deriveWrappingKey("Tr0ub4dor", salt);
    expect(() => unwrapKey(bad, wrapped)).toThrow();
  });

  it("X25519 seal: only the private-key holder can open it", () => {
    const alice = newKeyPair();
    const bob = newKeyPair();
    const familyKey = newDataKey();
    const sealed = sealTo(alice.publicKeyDer, familyKey);
    expect(unseal(alice.privateKeyDer, sealed).equals(familyKey)).toBe(true);
    expect(() => unseal(bob.privateKeyDer, sealed)).toThrow();
  });

  it("recovery codes are 20 Crockford chars, normalise loosely", () => {
    const code = newRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, " "))).toBe(code.replace(/-/g, ""));
  });
});

describe("vault/totp", () => {
  // RFC 6238 Appendix B test vector, SHA-1, 8 digits.
  const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // ASCII "12345678901234567890"

  it("matches the RFC 6238 test vector", () => {
    expect(base32Decode(RFC_SECRET_B32).toString("ascii")).toBe("12345678901234567890");
    const at59s = generateTotp(RFC_SECRET_B32, { digits: 8, algorithm: "SHA1", period: 30 }, 59_000);
    expect(at59s.code).toBe("94287082");
    const at1111111109 = generateTotp(RFC_SECRET_B32, { digits: 8, algorithm: "SHA1", period: 30 }, 1_111_111_109_000);
    expect(at1111111109.code).toBe("07081804");
  });

  it("reports seconds until rollover", () => {
    const r = generateTotp(RFC_SECRET_B32, { period: 30 }, 1_000 * (30 * 5 + 21));
    expect(r.expiresInSeconds).toBe(9);
  });

  it("parses an otpauth:// URI", () => {
    const p = parseOtpauthUri(
      "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30&algorithm=SHA1"
    );
    expect(p.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(p.issuer).toBe("GitHub");
    expect(p.label).toBe("octocat");
    expect(p.config).toEqual({ digits: 6, period: 30, algorithm: "SHA1" });
  });

  it("normalises a raw secret or a URI, and rejects junk", () => {
    expect(normalizeTotpInput("jbsw y3dp ehpk 3pxp").secret).toBe("JBSWY3DPEHPK3PXP");
    expect(normalizeTotpInput("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP").secret).toBe("JBSWY3DPEHPK3PXP");
    expect(() => normalizeTotpInput("not base 32 !!!")).toThrow();
  });
});

describe("VaultService", () => {
  let store: Store;
  let keyring: VaultKeyring;
  let vault: VaultService;
  let aliceId: string;
  let bobId: string;
  const wasEnabled = config.vaultEnabled;

  beforeEach(() => {
    config.vaultEnabled = true;
    store = new Store(":memory:");
    keyring = new VaultKeyring(60_000);
    vault = new VaultService(store, keyring);
    aliceId = store.createUser({ username: "alice", displayName: "Alice", password: "alicepw123", role: "admin" }).id;
    bobId = store.createUser({ username: "bob", displayName: "Bob", password: "bobpw12345" }).id;
  });

  afterEach(() => {
    keyring.lockAll();
    config.vaultEnabled = wasEnabled;
  });

  it("provisions, unlocks, and rejects a wrong password", () => {
    const { created, recoveryCode } = vault.provision(aliceId, "alicepw123");
    expect(created).toBe(true);
    expect(recoveryCode).toBeTruthy();
    expect(vault.status(aliceId).unlocked).toBe(true);

    keyring.lock(aliceId);
    expect(vault.unlock(aliceId, "wrong").ok).toBe(false);
    expect(vault.status(aliceId).unlocked).toBe(false);
    expect(vault.unlock(aliceId, "alicepw123").ok).toBe(true);
  });

  it("stores and reads back a private entry; the blob at rest reveals no secret", () => {
    vault.provision(aliceId, "alicepw123");
    const entry = vault.createEntry(aliceId, {
      scope: "private",
      title: "Netflix",
      username: "alice@example.com",
      password: "s3cr3t-pw",
      notes: "family plan",
    });
    const back = vault.getEntry(aliceId, entry.id);
    expect(back.secret.password).toBe("s3cr3t-pw");
    expect(back.secret.notes).toBe("family plan");

    const rawBlob = store.scoped(aliceId).getVaultSecretBlob(entry.id)!.blob;
    expect(rawBlob.toString("latin1")).not.toContain("s3cr3t-pw");
  });

  it("keeps one member's private entries invisible to another", () => {
    vault.provision(aliceId, "alicepw123");
    vault.provision(bobId, "bobpw12345");
    const secret = vault.createEntry(aliceId, { scope: "private", title: "Alice bank", password: "a" });
    expect(store.scoped(bobId).getVaultEntryMeta(secret.id)).toBeUndefined();
    expect(() => vault.getEntry(bobId, secret.id)).toThrow();
    expect(vault.listEntries(bobId)).toHaveLength(0);
  });

  it("shares the family vault once an admin syncs the key", () => {
    vault.provision(aliceId, "alicepw123"); // first vault -> mints the family key
    vault.provision(bobId, "bobpw12345"); // no family key yet
    expect(vault.status(bobId).hasSharedAccess).toBe(false);

    const granted = vault.syncFamilyKeys(aliceId);
    expect(granted).toBe(1);

    // Bob re-unlocks to pick up the freshly-sealed family key, then reads a
    // shared entry Alice created.
    keyring.lock(bobId);
    vault.unlock(bobId, "bobpw12345");
    const shared = vault.createEntry(aliceId, { scope: "shared", title: "Home Wi-Fi", password: "correcthorse" });
    expect(vault.getEntry(bobId, shared.id).secret.password).toBe("correcthorse");
    expect(vault.listEntries(bobId).map((e) => e.id)).toContain(shared.id);
  });

  it("throws VaultLockedError once the idle window passes", () => {
    const shortKeyring = new VaultKeyring(5);
    const v = new VaultService(store, shortKeyring);
    v.provision(aliceId, "alicepw123");
    const e = v.createEntry(aliceId, { scope: "private", title: "x", password: "y" });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(() => v.getEntry(aliceId, e.id)).toThrow(VaultLockedError);
        shortKeyring.lockAll();
        resolve();
      }, 30);
    });
  });

  it("recovers with the recovery code and issues a fresh one", () => {
    const { recoveryCode } = vault.provision(aliceId, "alicepw123");
    const e = vault.createEntry(aliceId, { scope: "private", title: "x", password: "keepme" });
    keyring.lock(aliceId);

    const bad = vault.recover(aliceId, "WRONG-CODE-HERE-XXXX", "newpw123456");
    expect(bad.ok).toBe(false);

    const ok = vault.recover(aliceId, recoveryCode!, "newpw123456");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.recoveryCode).not.toBe(recoveryCode);
    expect(vault.getEntry(aliceId, e.id).secret.password).toBe("keepme");

    keyring.lock(aliceId);
    expect(vault.unlock(aliceId, "newpw123456").ok).toBe(true);
  });

  it("re-wraps under a new password only while unlocked", () => {
    vault.provision(aliceId, "alicepw123");
    expect(vault.rewrapForNewPassword(aliceId, "brandnew123")).toBe(true);
    keyring.lock(aliceId);
    expect(vault.unlock(aliceId, "brandnew123").ok).toBe(true);

    keyring.lock(aliceId);
    expect(vault.rewrapForNewPassword(aliceId, "again12345")).toBe(false); // locked
  });
});
