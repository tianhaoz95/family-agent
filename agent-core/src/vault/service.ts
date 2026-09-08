import type { Store, VaultEntryRecord, VaultScope } from "../db.js";
import { config } from "../config.js";
import { VaultKeyring } from "./keyring.js";
import {
  AAD,
  DEFAULT_KDF,
  aeadDecrypt,
  aeadEncrypt,
  decryptSecret,
  deriveWrappingKey,
  encryptSecret,
  newDataKey,
  newKeyPair,
  newRecoveryCode,
  newSalt,
  normalizeRecoveryCode,
  sealTo,
  unseal,
  unwrapKey,
  wipe,
  wrapKey,
  type KdfParams,
} from "./crypto.js";
import { generateTotp, normalizeTotpInput, type TotpConfig } from "./totp.js";

// The one place that ties the vault's storage (db.ts), crypto (crypto.ts) and
// in-memory unlock state (keyring.ts) together. Both the HTTP routes and the
// vault-agent tools go through an instance of this — nothing else touches a
// data key.

/** The encrypted-at-rest payload of one entry. */
export interface VaultSecret {
  password?: string;
  totp?: { secret: string } & TotpConfig & { issuer?: string };
  notes?: string;
  fields?: { label: string; value: string; secret?: boolean }[];
}

export interface VaultEntryDetail extends VaultEntryRecord {
  secret: VaultSecret;
}

export class VaultLockedError extends Error {
  code = "VAULT_LOCKED" as const;
  constructor() {
    super("The vault is locked. Unlock it in the app first.");
  }
}
export class VaultDisabledError extends Error {
  code = "VAULT_DISABLED" as const;
  constructor(msg = "The password vault isn't turned on for this server.") {
    super(msg);
  }
}
export class VaultAccessError extends Error {
  code = "VAULT_NO_ACCESS" as const;
}

export type UnlockResult =
  | { ok: true; recoveryCode?: string }
  | { ok: false; reason: "not-set-up" | "bad-password" };

export type RecoverResult =
  | { ok: true; recoveryCode: string }
  | { ok: false; reason: "no-recovery" | "bad-code" };

export class VaultService {
  constructor(
    private readonly store: Store,
    readonly keyring: VaultKeyring
  ) {}

  get enabled(): boolean {
    return config.vaultEnabled;
  }
  get aiEnabled(): boolean {
    return config.vaultEnabled && config.vaultAiEnabled;
  }

  private assertEnabled(): void {
    if (!config.vaultEnabled) throw new VaultDisabledError();
  }

  status(userId: string) {
    const row = this.store.getVaultKeys(userId);
    return {
      enabled: config.vaultEnabled,
      aiEnabled: this.aiEnabled,
      exists: !!row,
      unlocked: config.vaultEnabled && this.keyring.isUnlocked(userId),
      hasRecovery: !!row?.dekWrappedRecovery,
      hasSharedAccess: !!row?.familyKeySealed,
      familyVaultInitialised: this.store.hasFamilyVaultKey(),
      entryCount: config.vaultEnabled ? this.store.scoped(userId).countVaultEntries() : 0,
    };
  }

  // ---- provisioning / unlock ----

  /**
   * Ensure this user has a key-wrapping row, creating it from `password` if
   * not. Called from the login / bootstrap / create-user routes, which are the
   * only places a plaintext password is in hand. Returns the one-time recovery
   * code only on first creation (it is never recoverable afterwards).
   * `provisionerId`, when given and holding an unlocked vault, is used to seal
   * the shared family key for this new member straight away.
   */
  provision(userId: string, password: string, provisionerId?: string): { created: boolean; recoveryCode?: string } {
    if (!config.vaultEnabled) return { created: false };
    if (this.store.getVaultKeys(userId)) {
      this.autoUnlock(userId, password);
      return { created: false };
    }

    const kdfParams = DEFAULT_KDF;
    const kdfSalt = newSalt();
    const kek = deriveWrappingKey(password, kdfSalt, kdfParams);
    const dek = newDataKey();
    const kp = newKeyPair();
    const recoveryCode = newRecoveryCode();
    const recoverySalt = newSalt();
    const recoveryKek = deriveWrappingKey(normalizeRecoveryCode(recoveryCode), recoverySalt, kdfParams);

    this.store.insertVaultKeys({
      userId,
      kdfParams: JSON.stringify(kdfParams),
      kdfSalt,
      dekWrappedLogin: wrapKey(kek, dek),
      recoverySalt,
      dekWrappedRecovery: wrapKey(recoveryKek, dek),
      publicKey: kp.publicKeyDer,
      // The private key is wrapped under the dek (not the KEK): login OR
      // recovery both yield the dek, and the dek yields the private key.
      privateKeyWrapped: aeadEncrypt(dek, kp.privateKeyDer, AAD.wrap),
      familyKeySealed: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Shared family key: the very first vault mints it; later members get it
    // from an admin (syncFamilyKeys) or, if a provisioner is unlocked now,
    // straight away.
    if (!this.store.hasFamilyVaultKey()) {
      const familyKey = newDataKey();
      this.store.setVaultFamilySeal(userId, sealTo(kp.publicKeyDer, familyKey));
      wipe(familyKey);
    } else if (provisionerId && this.keyring.isUnlocked(provisionerId)) {
      try {
        this.syncFamilyKeys(provisionerId);
      } catch {
        /* the member can still be granted access later; not fatal to signup */
      }
    }

    this.keyring.unlock(userId, dek, kp.privateKeyDer);
    wipe(kek, dek, recoveryKek, kp.privateKeyDer);
    return { created: true, recoveryCode };
  }

  /** Best-effort unlock during login — never throws, just leaves the vault
   *  locked if the password doesn't fit (e.g. after an admin password reset). */
  autoUnlock(userId: string, password: string): void {
    if (!config.vaultEnabled) return;
    try {
      this.unlock(userId, password);
    } catch {
      /* stays locked; client will prompt for an explicit unlock or recovery */
    }
  }

  unlock(userId: string, password: string): UnlockResult {
    this.assertEnabled();
    const row = this.store.getVaultKeys(userId);
    if (!row) return { ok: false, reason: "not-set-up" };
    const params = JSON.parse(row.kdfParams) as KdfParams;
    const kek = deriveWrappingKey(password, row.kdfSalt, params);
    let dek: Buffer;
    try {
      dek = unwrapKey(kek, row.dekWrappedLogin);
    } catch {
      wipe(kek);
      return { ok: false, reason: "bad-password" };
    }
    const priv = aeadDecrypt(dek, row.privateKeyWrapped, AAD.wrap);
    this.keyring.unlock(userId, dek, priv);
    wipe(kek, dek, priv);
    return { ok: true };
  }

  lock(userId: string): void {
    this.keyring.lock(userId);
  }

  /** Open the vault with the recovery code and re-wrap it under a new login
   *  password. Returns a fresh recovery code (the old one is now dead). */
  recover(userId: string, recoveryCode: string, newPassword: string): RecoverResult {
    this.assertEnabled();
    const row = this.store.getVaultKeys(userId);
    if (!row || !row.dekWrappedRecovery || !row.recoverySalt) {
      return { ok: false, reason: "no-recovery" };
    }
    const params = JSON.parse(row.kdfParams) as KdfParams;
    const recoveryKek = deriveWrappingKey(normalizeRecoveryCode(recoveryCode), row.recoverySalt, params);
    let dek: Buffer;
    try {
      dek = unwrapKey(recoveryKek, row.dekWrappedRecovery);
    } catch {
      wipe(recoveryKek);
      return { ok: false, reason: "bad-code" };
    }
    const priv = aeadDecrypt(dek, row.privateKeyWrapped, AAD.wrap);

    const newSaltBuf = newSalt();
    const newKek = deriveWrappingKey(newPassword, newSaltBuf, DEFAULT_KDF);
    this.store.setVaultLoginWrap(userId, {
      kdfParams: JSON.stringify(DEFAULT_KDF),
      kdfSalt: newSaltBuf,
      dekWrappedLogin: wrapKey(newKek, dek),
    });
    const freshCode = newRecoveryCode();
    const freshSalt = newSalt();
    this.store.setVaultRecoveryWrap(userId, {
      recoverySalt: freshSalt,
      dekWrappedRecovery: wrapKey(deriveWrappingKey(normalizeRecoveryCode(freshCode), freshSalt, DEFAULT_KDF), dek),
    });

    this.keyring.unlock(userId, dek, priv);
    wipe(recoveryKek, newKek, dek, priv);
    this.store.scoped(userId).logActivity("system", "vault.recovered", "Vault recovered with the recovery code and re-secured under a new password");
    return { ok: true, recoveryCode: freshCode };
  }

  /** Re-wrap the login copy of the dek after a password change. Only possible
   *  while the vault is unlocked; otherwise the recovery code is the way back
   *  in. Returns whether it happened. */
  rewrapForNewPassword(userId: string, newPassword: string): boolean {
    if (!config.vaultEnabled) return false;
    const dek = this.keyring.dek(userId);
    if (!dek) return false;
    const saltBuf = newSalt();
    const kek = deriveWrappingKey(newPassword, saltBuf, DEFAULT_KDF);
    this.store.setVaultLoginWrap(userId, {
      kdfParams: JSON.stringify(DEFAULT_KDF),
      kdfSalt: saltBuf,
      dekWrappedLogin: wrapKey(kek, dek),
    });
    wipe(kek);
    return true;
  }

  // ---- shared family key ----

  private familyKey(userId: string): Buffer {
    const row = this.store.getVaultKeys(userId);
    const priv = this.keyring.privateKey(userId);
    if (!priv) throw new VaultLockedError();
    if (!row?.familyKeySealed) {
      throw new VaultAccessError(
        "You don't have shared-vault access yet — ask a family admin to grant it from Settings."
      );
    }
    return unseal(priv, row.familyKeySealed);
  }

  /**
   * Grant the shared family key to every provisioned member who lacks it,
   * using only their stored public keys. `adminId` must have an unlocked vault
   * and already hold the family key (or be minting it because nobody does).
   * Returns how many members were granted access.
   */
  syncFamilyKeys(adminId: string): number {
    this.assertEnabled();
    const priv = this.keyring.privateKey(adminId);
    if (!priv) throw new VaultLockedError();
    const adminRow = this.store.getVaultKeys(adminId);
    if (!adminRow) throw new VaultAccessError("Set up your own vault first.");

    let familyKey: Buffer;
    if (adminRow.familyKeySealed) {
      familyKey = unseal(priv, adminRow.familyKeySealed);
    } else if (!this.store.hasFamilyVaultKey()) {
      familyKey = newDataKey();
      this.store.setVaultFamilySeal(adminId, sealTo(adminRow.publicKey, familyKey));
    } else {
      throw new VaultAccessError("You don't have shared-vault access yourself yet.");
    }

    let granted = 0;
    for (const m of this.store.listVaultPublicKeys()) {
      if (m.hasFamilyKey || m.userId === adminId) continue;
      this.store.setVaultFamilySeal(m.userId, sealTo(m.publicKey, familyKey));
      granted++;
    }
    wipe(familyKey);
    return granted;
  }

  // ---- entries ----

  private keyForScope(userId: string, scope: VaultScope): Buffer {
    if (scope === "shared") return this.familyKey(userId);
    const dek = this.keyring.dek(userId);
    if (!dek) throw new VaultLockedError();
    return dek;
  }

  listEntries(userId: string): VaultEntryRecord[] {
    this.assertEnabled();
    return this.store.scoped(userId).listVaultEntries();
  }

  getEntry(userId: string, id: string): VaultEntryDetail {
    this.assertEnabled();
    const found = this.store.scoped(userId).getVaultSecretBlob(id);
    if (!found) throw new VaultAccessError("No such vault entry.");
    const key = this.keyForScope(userId, found.meta.scope);
    const secret = decryptSecret<VaultSecret>(key, found.blob);
    return { ...found.meta, secret };
  }

  createEntry(
    userId: string,
    input: {
      scope: VaultScope;
      folder?: string | null;
      title: string;
      username?: string | null;
      url?: string | null;
      password?: string | null;
      totpInput?: string | null;
      notes?: string | null;
      fields?: { label: string; value: string; secret?: boolean }[];
    }
  ): VaultEntryRecord {
    this.assertEnabled();
    const secret = this.buildSecret(input);
    const key = this.keyForScope(userId, input.scope);
    return this.store.scoped(userId).createVaultEntry({
      scope: input.scope,
      folder: input.folder ?? null,
      title: input.title,
      username: input.username ?? null,
      url: input.url ?? null,
      hasTotp: !!secret.totp,
      secret: encryptSecret(key, secret),
    });
  }

  updateEntry(
    userId: string,
    id: string,
    patch: {
      folder?: string | null;
      title?: string;
      username?: string | null;
      url?: string | null;
      password?: string | null;
      totpInput?: string | null;
      clearTotp?: boolean;
      notes?: string | null;
      fields?: { label: string; value: string; secret?: boolean }[];
    }
  ): VaultEntryRecord {
    this.assertEnabled();
    const current = this.getEntry(userId, id); // also the access check + decrypt
    const key = this.keyForScope(userId, current.scope);
    const nextSecret: VaultSecret = { ...current.secret };
    if (patch.password !== undefined) {
      if (patch.password) nextSecret.password = patch.password;
      else delete nextSecret.password;
    }
    if (patch.notes !== undefined) {
      if (patch.notes) nextSecret.notes = patch.notes;
      else delete nextSecret.notes;
    }
    if (patch.fields !== undefined) nextSecret.fields = patch.fields.length ? patch.fields : undefined;
    if (patch.clearTotp) delete nextSecret.totp;
    else if (patch.totpInput) {
      const t = normalizeTotpInput(patch.totpInput);
      nextSecret.totp = { secret: t.secret, ...t.config, issuer: t.issuer };
    }
    const metaPatch = {
      folder: patch.folder,
      title: patch.title,
      username: patch.username,
      url: patch.url,
      hasTotp: !!nextSecret.totp,
      secret: encryptSecret(key, nextSecret),
    };
    return this.store.scoped(userId).updateVaultEntry(id, metaPatch)!;
  }

  deleteEntry(userId: string, id: string): VaultEntryRecord {
    this.assertEnabled();
    const meta = this.store.scoped(userId).deleteVaultEntry(id);
    if (!meta) throw new VaultAccessError("No such vault entry.");
    return meta;
  }

  /** Reveal a password. `actor` is "user" or "vault-agent"; `onReveal` lets the
   *  chat route redact the value out of the stored transcript. */
  revealPassword(
    userId: string,
    id: string,
    opts: { actor: string; onReveal?: (secret: string) => void }
  ): { entry: VaultEntryRecord; username: string | null; password: string | null; notes?: string } {
    const detail = this.getEntry(userId, id);
    this.store.scoped(userId).logVaultAccess(opts.actor, "reveal_password", { id, title: detail.title });
    if (detail.secret.password) opts.onReveal?.(detail.secret.password);
    return {
      entry: this.toMeta(detail),
      username: detail.username ?? null,
      password: detail.secret.password ?? null,
      notes: detail.secret.notes,
    };
  }

  currentTotp(
    userId: string,
    id: string,
    opts: { actor: string; onReveal?: (secret: string) => void }
  ): { entry: VaultEntryRecord; code: string; expiresInSeconds: number } {
    const detail = this.getEntry(userId, id);
    if (!detail.secret.totp) throw new VaultAccessError(`"${detail.title}" has no two-factor code set up.`);
    const t = detail.secret.totp;
    const result = generateTotp(t.secret, { digits: t.digits, period: t.period, algorithm: t.algorithm });
    // The Vault screen polls this once a second to show the ticking code — that
    // isn't audit-worthy and would bury the entries that matter. Only log when
    // the assistant (or any non-"user" actor) read it.
    if (opts.actor !== "user") {
      this.store.scoped(userId).logVaultAccess(opts.actor, "reveal_totp", { id, title: detail.title });
    }
    opts.onReveal?.(result.code);
    return { entry: this.toMeta(detail), code: result.code, expiresInSeconds: result.expiresInSeconds };
  }

  accessLog(userId: string, limit = 100) {
    this.assertEnabled();
    return this.store.scoped(userId).listVaultAccessLog(limit);
  }

  // ---- helpers ----

  private buildSecret(input: {
    password?: string | null;
    totpInput?: string | null;
    notes?: string | null;
    fields?: { label: string; value: string; secret?: boolean }[];
  }): VaultSecret {
    const secret: VaultSecret = {};
    if (input.password) secret.password = input.password;
    if (input.notes) secret.notes = input.notes;
    if (input.fields?.length) secret.fields = input.fields;
    if (input.totpInput) {
      const t = normalizeTotpInput(input.totpInput);
      secret.totp = { secret: t.secret, ...t.config, issuer: t.issuer };
    }
    return secret;
  }

  private toMeta(d: VaultEntryDetail): VaultEntryRecord {
    const { secret, ...meta } = d;
    void secret;
    return meta;
  }
}
