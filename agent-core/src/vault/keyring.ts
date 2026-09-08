import { wipe } from "./crypto.js";

// The in-memory unlock state for every signed-in family member's vault. This
// is the whole reason the vault can be "always available to the assistant"
// without a human in the loop at query time AND still be encrypted at rest:
// the data-encryption key lives here, in RAM, only between an unlock and either
// an idle timeout, an explicit lock, sign-out, or process exit. A server
// restart wipes it — clients re-unlock (POST /vault/unlock) on the next 423.
//
// Process-wide, one instance (like ToolSupervisor / RoutineScheduler /
// McpManager), owned by server.ts.

interface Entry {
  dek: Buffer;
  /** The user's X25519 private key (DER), for opening the sealed family key. */
  privateKey: Buffer;
  lastUsed: number;
}

export class VaultKeyring {
  private entries = new Map<string, Entry>();
  private sweeper: NodeJS.Timeout | undefined;

  constructor(private readonly idleMs: number) {}

  unlock(userId: string, dek: Buffer, privateKey: Buffer): void {
    this.lock(userId); // wipe any previous material first
    this.entries.set(userId, { dek: Buffer.from(dek), privateKey: Buffer.from(privateKey), lastUsed: Date.now() });
    this.ensureSweeper();
  }

  private fresh(userId: string): Entry | undefined {
    const e = this.entries.get(userId);
    if (!e) return undefined;
    if (Date.now() - e.lastUsed > this.idleMs) {
      this.lock(userId);
      return undefined;
    }
    e.lastUsed = Date.now();
    return e;
  }

  isUnlocked(userId: string): boolean {
    return !!this.fresh(userId);
  }

  /** The data-encryption key, or undefined when locked. Do not retain it. */
  dek(userId: string): Buffer | undefined {
    return this.fresh(userId)?.dek;
  }

  privateKey(userId: string): Buffer | undefined {
    return this.fresh(userId)?.privateKey;
  }

  lock(userId: string): void {
    const e = this.entries.get(userId);
    if (!e) return;
    wipe(e.dek, e.privateKey);
    this.entries.delete(userId);
  }

  lockAll(): void {
    for (const id of [...this.entries.keys()]) this.lock(id);
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      for (const [id, e] of this.entries) {
        if (Date.now() - e.lastUsed > this.idleMs) this.lock(id);
      }
      if (this.entries.size === 0 && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = undefined;
      }
    }, 60_000);
    this.sweeper.unref?.();
  }
}
