import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";

// Local family accounts. No OAuth, no OS-account integration, no external
// identity provider — the whole point of this app is that it runs on one
// family's laptop and talks to nobody. A username + password checked against
// a scrypt hash in the local SQLite DB, exchanged for an opaque bearer token,
// is all the trust boundary here needs. See docs/DECISIONS.md.

// scrypt parameters. N=2^15 is comfortably fast for an interactive login on a
// laptop while being expensive to brute-force. `maxmem` has to be raised
// above Node's 32 MB default to allow it (128 * N * r ≈ 32 MB at r=8).
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const KEYLEN = 64;
const SALT_BYTES = 16;
const scryptOpts = { N: SCRYPT_N, r: SCRYPT_R, maxmem: SCRYPT_MAXMEM };

/**
 * Hash a plaintext password for storage. Format: `scrypt$<saltHex>$<hashHex>`
 * — self-describing so a future parameter change can be detected per-row.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEYLEN, scryptOpts);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Constant-time verify of a plaintext password against a stored hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, scryptOpts);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A fresh session token to hand back to a client. Random, URL-safe, never
 * persisted verbatim — only its sha256 goes in the `sessions` table, so a
 * leaked database file can't be used to impersonate anyone.
 */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 hex — used to key sessions by a token's digest, not the token. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Pull a bearer token out of an Authorization header value, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}
