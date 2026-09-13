import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

describe("HTTP API — family wiki", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let member: SeededUser;
  let realDataDir: string;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-wiki-"));
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    member = seedUser(store, { username: "kid", role: "member" });
  });
  afterEach(async () => {
    await app.close();
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
  });

  it("/health reports it always on", async () => {
    expect((await app.inject("/health")).json().wiki).toBe(true);
  });

  it("creates, lists, and fetches a page", async () => {
    const created = await authInject(app, admin.token)({
      method: "POST",
      url: "/wiki",
      payload: { title: "House Rules", body: "# Rules\n\nNo shoes inside." },
    });
    expect(created.statusCode).toBe(200);
    const page = created.json().page;
    expect(page.title).toBe("House Rules");
    expect(page.revision).toBe(0);
    expect(page.createdBy).toBe(admin.user.id);

    const list = await authInject(app, member.token)("/wiki");
    expect(list.json().pages).toHaveLength(1);

    const fetched = await authInject(app, member.token)(`/wiki/${page.id}`);
    expect(fetched.json().page.body).toContain("No shoes inside.");
  });

  it("is fully collaborative — any signed-in member can edit any page, no ownership check", async () => {
    const page = store.createWikiPage("Shared page", "v1", admin.user.id);

    const edited = await authInject(app, member.token)({
      method: "PATCH",
      url: `/wiki/${page.id}`,
      payload: { body: "v2 — edited by kid" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().page.body).toBe("v2 — edited by kid");
    expect(edited.json().page.updatedBy).toBe(member.user.id);
    expect(edited.json().page.revision).toBe(1);
  });

  it("resolves createdBy/updatedBy to display names for clients, without changing the id fields", async () => {
    const created = await authInject(app, admin.token)({
      method: "POST",
      url: "/wiki",
      payload: { title: "Names", body: "x" },
    });
    expect(created.json().page.createdByName).toBe(admin.user.displayName);
    expect(created.json().page.updatedByName).toBe(admin.user.displayName);

    const edited = await authInject(app, member.token)({
      method: "PATCH",
      url: `/wiki/${created.json().page.id}`,
      payload: { body: "y" },
    });
    expect(edited.json().page.updatedByName).toBe(member.user.displayName);
    expect(edited.json().page.createdByName).toBe(admin.user.displayName); // unchanged
  });

  it("keeps one prior body for a one-step revert, same shape as artifacts", async () => {
    const page = store.createWikiPage("Recipe", "original text", admin.user.id);
    await authInject(app, admin.token)({ method: "PATCH", url: `/wiki/${page.id}`, payload: { body: "edited text" } });

    const reverted = await authInject(app, admin.token)({ method: "POST", url: `/wiki/${page.id}/revert` });
    expect(reverted.json().page.body).toBe("original text");
    expect(reverted.json().page.revision).toBe(2); // edit (1) + revert (2)

    // A second revert with nothing to go back to is a no-op, not an error.
    const again = await authInject(app, admin.token)({ method: "POST", url: `/wiki/${page.id}/revert` });
    expect(again.statusCode).toBe(200);
    expect(again.json().page.body).toBe("original text");
  });

  it("title-only edits don't touch the revert history", async () => {
    const page = store.createWikiPage("Old title", "body", admin.user.id);
    const renamed = await authInject(app, admin.token)({
      method: "PATCH",
      url: `/wiki/${page.id}`,
      payload: { title: "New title" },
    });
    expect(renamed.json().page.title).toBe("New title");
    expect(renamed.json().page.revision).toBe(0); // unchanged — body wasn't touched
  });

  it("deletes a page", async () => {
    const page = store.createWikiPage("Temp", "x", admin.user.id);
    const del = await authInject(app, admin.token)({ method: "DELETE", url: `/wiki/${page.id}` });
    expect(del.json().deleted).toBe(true);
    expect((await authInject(app, admin.token)(`/wiki/${page.id}`)).statusCode).toBe(404);
  });

  it("rejects an empty title", async () => {
    const res = await authInject(app, admin.token)({ method: "POST", url: "/wiki", payload: { title: "" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("HTTP API — family gallery", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let member: SeededUser;
  let realDataDir: string;
  const tinyPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-gallery-"));
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    member = seedUser(store, { username: "kid", role: "member" });
  });
  afterEach(async () => {
    await app.close();
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
  });

  it("/health reports it always on", async () => {
    expect((await app.inject("/health")).json().gallery).toBe(true);
  });

  it("uploads a shared photo everyone can see, and a private one only the uploader sees", async () => {
    const shared = await authInject(app, admin.token)({
      method: "POST",
      url: "/gallery",
      payload: { scope: "shared", image: tinyPng, thumb: tinyPng, caption: "Beach day" },
    });
    expect(shared.statusCode).toBe(200);
    expect(shared.json().photo.caption).toBe("Beach day");

    const priv = await authInject(app, admin.token)({
      method: "POST",
      url: "/gallery",
      payload: { scope: "private", image: tinyPng, thumb: tinyPng },
    });
    expect(priv.statusCode).toBe(200);

    const memberSharedList = await authInject(app, member.token)("/gallery?scope=shared");
    expect(memberSharedList.json().photos).toHaveLength(1);

    const memberPrivateList = await authInject(app, member.token)("/gallery?scope=private");
    expect(memberPrivateList.json().photos).toHaveLength(0); // admin's private photo isn't member's

    const adminPrivateList = await authInject(app, admin.token)("/gallery?scope=private");
    expect(adminPrivateList.json().photos).toHaveLength(1);
  });

  it("the list omits the full image (thumbnail only); GET :id returns the full image", async () => {
    const created = await authInject(app, admin.token)({
      method: "POST",
      url: "/gallery",
      payload: { scope: "shared", image: tinyPng, thumb: tinyPng },
    });
    const id = created.json().photo.id;

    const list = await authInject(app, admin.token)("/gallery?scope=shared");
    expect(list.json().photos[0].thumb).toBe(tinyPng);
    expect(list.json().photos[0].image).toBe("");

    const one = await authInject(app, admin.token)(`/gallery/${id}`);
    expect(one.json().photo.image).toBe(tinyPng);
  });

  it("a private photo 404s for anyone but its uploader", async () => {
    const created = await authInject(app, admin.token)({
      method: "POST",
      url: "/gallery",
      payload: { scope: "private", image: tinyPng, thumb: tinyPng },
    });
    const id = created.json().photo.id;
    expect((await authInject(app, member.token)(`/gallery/${id}`)).statusCode).toBe(404);
    expect((await authInject(app, admin.token)(`/gallery/${id}`)).statusCode).toBe(200);
  });

  it("edits a caption and deletes a photo", async () => {
    const created = await authInject(app, admin.token)({
      method: "POST",
      url: "/gallery",
      payload: { scope: "shared", image: tinyPng, thumb: tinyPng },
    });
    const id = created.json().photo.id;

    const edited = await authInject(app, admin.token)({
      method: "PATCH",
      url: `/gallery/${id}`,
      payload: { caption: "Updated caption" },
    });
    expect(edited.json().photo.caption).toBe("Updated caption");

    const del = await authInject(app, admin.token)({ method: "DELETE", url: `/gallery/${id}` });
    expect(del.json().photo.id).toBe(id);
    expect((await authInject(app, admin.token)(`/gallery/${id}`)).statusCode).toBe(404);
  });

  it("rejects a non-image data URI", async () => {
    const res = await authInject(app, admin.token)({
      method: "POST",
      url: "/gallery",
      payload: { scope: "shared", image: "data:text/html,<script>", thumb: tinyPng },
    });
    expect(res.statusCode).toBe(400);
  });
});
