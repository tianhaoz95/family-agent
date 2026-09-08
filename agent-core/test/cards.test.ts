import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { wrapCard, validateCardFragment } from "../src/cards/wrap.js";
import { makeCardTools } from "../src/agents/cardTools.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

describe("cards/wrap", () => {
  it("wraps a fragment into a full sealed document", () => {
    const r = wrapCard({ id: "c1", title: "Trend", fragment: "<div class='card'>hi</div>" });
    expect(r.html).toContain("<!doctype html>");
    // The sandbox CSP — no connect-src => fetch/XHR are dead.
    expect(r.html).toContain("Content-Security-Policy");
    expect(r.html).toContain("default-src 'none'");
    expect(r.html).not.toContain("connect-src");
    expect(r.html).toContain("<div class='card'>hi</div>");
    // Runtime present (measurement / Card helper).
    expect(r.html).toContain("card-height");
    expect(r.html).toContain("window.Card");
    expect(r.fragment).toBe("<div class='card'>hi</div>");
  });

  it("validateCardFragment rejects a full document, oversize, and broken script", () => {
    expect(validateCardFragment("").ok).toBe(false);
    expect(validateCardFragment("<!doctype html><body>x</body>").ok).toBe(false);
    expect(validateCardFragment("<html>x</html>").ok).toBe(false);
    expect(validateCardFragment("<p>x".repeat(20000)).ok).toBe(false);
    expect(validateCardFragment("<script>function( {</script>").ok).toBe(false);
    expect(validateCardFragment("<div>ok</div><script>const a = 1;</script>").ok).toBe(true);
    // A Card.…() call in the markup (not a <script>) is the classic mistake.
    expect(validateCardFragment("<div>Card.barChart({a:1})</div>").ok).toBe(false);
    expect(
      validateCardFragment("<div id='c'></div><script>c.innerHTML = Card.barChart({})</script>").ok
    ).toBe(true);
  });

  it("render_card tool collects a card and asks for a text summary", async () => {
    const collected: any[] = [];
    const [renderCard] = makeCardTools({ onCard: (c) => collected.push(c) });
    const out = await renderCard.invoke({ title: "Water bill", html: "<div class='card'>chart</div>" });
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ title: "Water bill", fragment: "<div class='card'>chart</div>" });
    expect(collected[0].id).toBeTruthy();
    expect(String(out)).toMatch(/summari[sz]ing/i);
  });

  it("render_card bounces a broken fragment back to the model", async () => {
    const [renderCard] = makeCardTools({ onCard: () => {} });
    const out = await renderCard.invoke({ title: "x", html: "<script>oops(</script>" });
    expect(String(out)).toMatch(/syntax error/i);
  });
});

describe("HTTP API — cards", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let member: SeededUser;
  const wasEnabled = config.cardsEnabled;

  beforeEach(() => {
    config.cardsEnabled = true;
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    member = seedUser(store, { username: "kid", role: "member" });
  });
  afterEach(async () => {
    await app.close();
    config.cardsEnabled = wasEnabled;
    vi.restoreAllMocks();
  });

  it("/health and /settings expose the toggle; a member can't flip it", async () => {
    expect((await app.inject("/health")).json().cards).toBe("on");
    expect((await authInject(app, admin.token)("/settings")).json().cardsEnabled).toBe(true);

    const asMember = await authInject(app, member.token)({
      method: "PUT",
      url: "/settings",
      payload: { cardsEnabled: false },
    });
    expect(asMember.statusCode).toBe(403);

    const asAdmin = await authInject(app, admin.token)({
      method: "PUT",
      url: "/settings",
      payload: { cardsEnabled: false },
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(config.cardsEnabled).toBe(false);
    expect((await app.inject("/health")).json().cards).toBe("off");
  });

  it("a persisted card comes back wrapped (fragment stored, document rendered on read)", async () => {
    const scoped = store.scoped(admin.user.id);
    const session = scoped.createChatSession("hi");
    scoped.addChatMessage(session.id, "assistant", "Here's the trend.", [], [], [], [
      { id: "cardA", title: "Spending", fragment: "<div class='card'>bars</div>" },
    ]);
    const res = await authInject(app, admin.token)(`/chat/sessions/${session.id}/messages`);
    const msg = res.json().messages.at(-1);
    expect(msg.cards).toHaveLength(1);
    expect(msg.cards[0]).toMatchObject({ id: "cardA", title: "Spending", fragment: "<div class='card'>bars</div>" });
    expect(msg.cards[0].html).toContain("<!doctype html>");
    expect(msg.cards[0].html).toContain("<div class='card'>bars</div>");
  });

  it("a family-channel message wraps its persisted cards too", async () => {
    const dm = store.findOrCreateDm(admin.user.id, member.user.id);
    const pending = store.insertPendingAgentMessage(dm.id);
    store.resolvePendingAgentMessage(pending.id, "Done.", [], [
      { id: "cB", title: "Week", fragment: "<ul><li>Mon</li></ul>" },
    ]);
    const res = await authInject(app, admin.token)(`/channels/${dm.id}/messages`);
    const agentMsg = res.json().messages.find((m: any) => m.senderId === "_agent_");
    expect(agentMsg.cards[0].title).toBe("Week");
    expect(agentMsg.cards[0].html).toContain("<li>Mon</li>");
  });

  it("/chat response always carries a cards array", async () => {
    const idx = await import("../src/agents/index.js");
    vi.spyOn(idx, "askFamilyAgent").mockResolvedValue("A short answer.");
    const res = await authInject(app, admin.token)({
      method: "POST",
      url: "/chat",
      payload: { message: "hello" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cards).toEqual([]);
  });
});
