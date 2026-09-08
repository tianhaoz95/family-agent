import {
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  hkdfSync,
} from "node:crypto";

// The password vault's crypto envelope. Everything sensitive a family member
// stores (a password, a TOTP seed, notes) is AES-256-GCM encrypted at rest
// with a key the server only ever holds *in memory*, and only while that
// member is signed in. A stolen family-agent.db reveals entry titles and
// usernames but not a single secret.
//
// Rolled here rather than pulled from a library on purpose: it's a small,
// standard construction (scrypt KDF + AES-GCM AEAD + X25519 seal for the
// shared "family" key), it matches the "hand-rolled, minimal deps" personality
// of the rest of agent-core (see auth.ts's own scrypt use, mcp/client.ts's
// hand-rolled JSON-RPC), and it keeps the whole thing auditable in one file.
// See docs/DECISIONS.md → "Password vault".

// ---- key-derivation (login password / recovery code -> a wrapping key) ----

export interface KdfParams {
  algo: "scrypt";
  N: number;
  r: number;
  p: number;
  keylen: number;
}

// Same scrypt cost as auth.ts's password hashing — comfortably fast for an
// interactive unlock on a laptop, expensive to brute-force. `maxmem` has to be
// raised over Node's 32 MB default (128 * N * r ≈ 32 MB at r=8).
export const DEFAULT_KDF: KdfParams = { algo: "scrypt", N: 1 << 15, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

export function deriveWrappingKey(
  secret: string,
  salt: Buffer,
  params: KdfParams = DEFAULT_KDF
): Buffer {
  if (params.algo !== "scrypt") throw new Error(`vault: unknown KDF "${params.algo}"`);
  return scryptSync(secret, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

export const newSalt = (): Buffer => randomBytes(16);
/** A fresh 256-bit symmetric key (a data-encryption key, or the family key). */
export const newDataKey = (): Buffer => randomBytes(32);

// A one-time recovery code shown at vault setup: 20 Crockford-base32 chars
// (~100 bits) in XXXXX-XXXXX-XXXXX-XXXXX groups. `normalizeRecoveryCode`
// strips the grouping/spacing and upper-cases so the user can type it back
// loosely.
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newRecoveryCode(): string {
  const b = randomBytes(20);
  let s = "";
  for (let i = 0; i < 20; i++) s += RECOVERY_ALPHABET[b[i] % 32];
  return s.replace(/(.{5})(?=.)/g, "$1-");
}
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

// ---- symmetric AEAD (AES-256-GCM) ----
// Blob layout: nonce(12) || ciphertext || tag(16). The AAD string is pure
// domain separation — a key-wrap blob can never be decrypted as an entry blob
// even with the same key.

const NONCE_LEN = 12;
const TAG_LEN = 16;

export const AAD = {
  wrap: "familyagent.vault.keywrap.v1",
  entry: "familyagent.vault.entry.v1",
  seal: "familyagent.vault.familyseal.v1",
} as const;

export function aeadEncrypt(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

export function aeadDecrypt(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error("vault: ciphertext too short");
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Wrap a data key under a wrapping key. Throws on the wrong key (the GCM tag
 *  won't verify) — that's how `unlock` tells a bad password from a good one. */
export const wrapKey = (wrappingKey: Buffer, dataKey: Buffer): Buffer =>
  aeadEncrypt(wrappingKey, dataKey, AAD.wrap);
export const unwrapKey = (wrappingKey: Buffer, blob: Buffer): Buffer =>
  aeadDecrypt(wrappingKey, blob, AAD.wrap);

export function encryptSecret(dataKey: Buffer, secret: unknown): Buffer {
  return aeadEncrypt(dataKey, Buffer.from(JSON.stringify(secret), "utf8"), AAD.entry);
}
export function decryptSecret<T = unknown>(dataKey: Buffer, blob: Buffer): T {
  return JSON.parse(aeadDecrypt(dataKey, blob, AAD.entry).toString("utf8")) as T;
}

// ---- asymmetric seal (X25519 + HKDF-SHA256 + AES-256-GCM) ----
// Used only for the shared "family" key. Because it's public-key, an admin
// whose own vault is unlocked can grant the family key to any *other* member
// using only that member's stored public key — no need for the member to be
// present or to type anything. See VaultService.syncFamilyKeys.
//
// Keys are stored as DER (SPKI for public, PKCS8 for private) — portable and
// with no raw-key import quirks across Node versions.

// X25519 SPKI DER is a fixed 44 bytes (12-byte header + 32-byte key).
const X25519_SPKI_DER_LEN = 44;

export interface VaultKeyPair {
  publicKeyDer: Buffer;
  privateKeyDer: Buffer;
}

export function newKeyPair(): VaultKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const privateKeyDer = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  if (publicKeyDer.length !== X25519_SPKI_DER_LEN) {
    throw new Error(`vault: unexpected X25519 public key length ${publicKeyDer.length}`);
  }
  return { publicKeyDer, privateKeyDer };
}

/** Seal `plaintext` so only the holder of the private key for
 *  `recipientPublicKeyDer` can open it. Blob: ephPub(44) || nonce(12) || ct || tag(16). */
export function sealTo(recipientPublicKeyDer: Buffer, plaintext: Buffer): Buffer {
  const recipient = createPublicKey({ key: recipientPublicKeyDer, type: "spki", format: "der" });
  const eph = generateKeyPairSync("x25519");
  const ephPubDer = eph.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync("sha256", shared, ephPubDer, Buffer.from(AAD.seal, "utf8"), 32));
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(ephPubDer);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ephPubDer, nonce, ct, cipher.getAuthTag()]);
}

export function unseal(recipientPrivateKeyDer: Buffer, blob: Buffer): Buffer {
  if (blob.length < X25519_SPKI_DER_LEN + NONCE_LEN + TAG_LEN) {
    throw new Error("vault: sealed blob too short");
  }
  const ephPubDer = blob.subarray(0, X25519_SPKI_DER_LEN);
  const nonce = blob.subarray(X25519_SPKI_DER_LEN, X25519_SPKI_DER_LEN + NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(X25519_SPKI_DER_LEN + NONCE_LEN, blob.length - TAG_LEN);
  const priv = createPrivateKey({ key: recipientPrivateKeyDer, type: "pkcs8", format: "der" });
  const ephPub = createPublicKey({ key: ephPubDer, type: "spki", format: "der" });
  const shared = diffieHellman({ privateKey: priv, publicKey: ephPub });
  const key = Buffer.from(hkdfSync("sha256", shared, ephPubDer, Buffer.from(AAD.seal, "utf8"), 32));
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(ephPubDer);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Best-effort wipe of key material held in a Buffer. */
export function wipe(...buffers: (Buffer | null | undefined)[]): void {
  for (const b of buffers) b?.fill(0);
}
