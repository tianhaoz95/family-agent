import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "../src/api.js";

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "status",
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("health() hits /health and returns the parsed body", async () => {
    const fetchMock = mockFetchOnce(200, { ok: true, model: "qwen2.5:3b", inboxDir: "/data/inbox" });
    const health = await api.health();
    expect(health.model).toBe("qwen2.5:3b");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/health");
  });

  it("createTask() sends title and dueDate in the body", async () => {
    const fetchMock = mockFetchOnce(200, { task: { id: "X", title: "Buy stamps" } });
    await api.createTask("Buy stamps", "2026-09-10");
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual({ title: "Buy stamps", dueDate: "2026-09-10" });
    expect((init as RequestInit).method).toBe("POST");
  });

  it("createTask() omits dueDate when not given", async () => {
    const fetchMock = mockFetchOnce(200, { task: { id: "X", title: "Buy stamps" } });
    await api.createTask("Buy stamps");
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.dueDate).toBeUndefined();
  });

  it("throws a readable error on a non-ok response with an error body", async () => {
    mockFetchOnce(500, { error: "model unreachable" });
    await expect(api.chat("hi")).rejects.toThrow("model unreachable");
  });

  it("throws a readable error on a non-ok response with no parseable body", async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new Error("not json");
      },
    });
    vi.stubGlobal("fetch", fn);
    await expect(api.chat("hi")).rejects.toThrow("502");
  });

  it("completeTask() PATCHes the right task id with status done", async () => {
    const fetchMock = mockFetchOnce(200, { task: { id: "ABC123", status: "done" } });
    await api.completeTask("ABC123");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/tasks/ABC123");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ status: "done" });
  });
});
