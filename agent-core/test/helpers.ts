import type { FastifyInstance, InjectOptions } from "fastify";
import { Store, type ScopedStore, type UserRecord } from "../src/db.js";

export interface SeededUser {
  user: UserRecord;
  token: string;
  password: string;
  scoped: ScopedStore;
}

/** Create a user + an active session token for tests. Admin by default. */
export function seedUser(
  store: Store,
  opts: { username?: string; password?: string; displayName?: string; role?: "admin" | "member" } = {}
): SeededUser {
  const username = opts.username ?? "owner";
  const password = opts.password ?? "sekret123";
  const user = store.createUser({
    username,
    displayName: opts.displayName ?? username,
    password,
    role: opts.role ?? "admin",
  });
  const { token } = store.createSession(user.id, "test");
  return { user, token, password, scoped: store.scoped(user.id) };
}

/** app.inject that attaches a bearer token (still overridable per call). */
export function authInject(app: FastifyInstance, token: string) {
  return (opts: InjectOptions | string) => {
    const o: InjectOptions = typeof opts === "string" ? { url: opts } : opts;
    return app.inject({ ...o, headers: { authorization: `Bearer ${token}`, ...(o.headers ?? {}) } });
  };
}
