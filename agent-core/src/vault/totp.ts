import { createHmac } from "node:crypto";

// RFC 6238 time-based one-time passwords, plus otpauth:// URI parsing so a
// family member can paste the "add authenticator" link (or scan its QR on
// Android) straight in. ~1 KB, no dependency — the same call as auth.ts's
// hand-rolled scrypt format and mcp/client.ts's hand-rolled JSON-RPC.

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpConfig {
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
}

export const DEFAULT_TOTP: TotpConfig = { digits: 6, period: 30, algorithm: "SHA1" };

/** Decode a base32 (RFC 4648, no padding required) secret to bytes. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean) throw new Error("empty base32 secret");
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface TotpResult {
  code: string;
  /** Whole seconds until this code rolls over to the next one. */
  expiresInSeconds: number;
  period: number;
}

export function generateTotp(
  secretBase32: string,
  config: Partial<TotpConfig> = {},
  atMs: number = Date.now()
): TotpResult {
  const { digits, period, algorithm } = { ...DEFAULT_TOTP, ...config };
  const key = base32Decode(secretBase32);
  const nowSec = Math.floor(atMs / 1000);
  const counter = Math.floor(nowSec / period);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm.toLowerCase(), key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  const code = (bin % 10 ** digits).toString().padStart(digits, "0");
  return { code, expiresInSeconds: period - (nowSec % period), period };
}

export interface ParsedOtpauth {
  secret: string;
  label: string;
  issuer: string;
  config: TotpConfig;
}

export function parseOtpauthUri(uri: string): ParsedOtpauth {
  let u: URL;
  try {
    u = new URL(uri.trim());
  } catch {
    throw new Error("not a valid otpauth:// URI");
  }
  if (u.protocol !== "otpauth:") throw new Error("not an otpauth:// URI");
  if (u.host.toLowerCase() !== "totp") {
    throw new Error("only time-based (TOTP) codes are supported, not this URI's type");
  }
  const p = u.searchParams;
  const secret = (p.get("secret") ?? "").replace(/\s/g, "");
  if (!secret) throw new Error("the otpauth URI has no secret");
  base32Decode(secret); // validate now, not at first use

  const rawLabel = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
  let labelIssuer = "";
  let account = rawLabel;
  const colon = rawLabel.indexOf(":");
  if (colon !== -1) {
    labelIssuer = rawLabel.slice(0, colon).trim();
    account = rawLabel.slice(colon + 1).trim();
  }
  const algorithm = (p.get("algorithm") ?? "SHA1").toUpperCase();
  return {
    secret: secret.toUpperCase(),
    label: account || rawLabel,
    issuer: (p.get("issuer") ?? labelIssuer ?? "").trim(),
    config: {
      digits: clampInt(p.get("digits"), 6, 4, 10),
      period: clampInt(p.get("period"), 30, 5, 300),
      algorithm: (["SHA1", "SHA256", "SHA512"].includes(algorithm)
        ? algorithm
        : "SHA1") as TotpAlgorithm,
    },
  };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export interface NormalizedTotp {
  secret: string;
  config: TotpConfig;
  issuer?: string;
  label?: string;
}

/** Accept either a raw base32 secret or a full otpauth:// URI and return a
 *  canonical {secret, config}. Throws with a human message on anything
 *  unusable, so the route/tool can hand that straight to the user. */
export function normalizeTotpInput(input: string): NormalizedTotp {
  const trimmed = input.trim();
  if (/^otpauth:\/\//i.test(trimmed)) {
    const parsed = parseOtpauthUri(trimmed);
    return {
      secret: parsed.secret,
      config: parsed.config,
      issuer: parsed.issuer || undefined,
      label: parsed.label || undefined,
    };
  }
  const secret = trimmed.replace(/[\s-]/g, "").toUpperCase();
  base32Decode(secret); // throws if invalid
  return { secret, config: { ...DEFAULT_TOTP } };
}
