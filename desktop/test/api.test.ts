import { describe, it, expect, vi, afterEach } from "vitest";
import { api, setToken, clearToken, SIGNED_OUT_EVENT } from "../src/api.js";

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
    clearToken();
  });

  it("health() hits /health and returns the parsed body", async () => {
    const fetchMock = mockFetchOnce(200, { ok: true, model: "qwen2.5:3b", serverName: "Home", needsSetup: false });
    const health = await api.health();
    expect(health.model).toBe("qwen2.5:3b");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/health");
  });

  it("attaches a bearer token to requests once one is set", async () => {
    setToken("tok-abc");
    const fetchMock = mockFetchOnce(200, { tasks: [] });
    await api.listTasks();
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-abc");
  });

  it("login() posts credentials and does not need a prior token", async () => {
    const fetchMock = mockFetchOnce(200, { token: "t1", user: { id: "u", username: "a", displayName: "A", role: "admin" } });
    const res = await api.login("a", "pw");
    expect(res.token).toBe("t1");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ username: "a", password: "pw" });
  });

  it("a 401 clears the token and fires the signed-out event", async () => {
    setToken("stale");
    let fired = false;
    const onOut = () => { fired = true; };
    globalThis.addEventListener?.(SIGNED_OUT_EVENT, onOut);
    mockFetchOnce(401, { error: "Not signed in." });
    await expect(api.listTasks()).rejects.toThrow();
    globalThis.removeEventListener?.(SIGNED_OUT_EVENT, onOut);
    // token is cleared regardless of whether a window exists to hear the event
    const fetchMock = mockFetchOnce(200, { tasks: [] });
    await api.listTasks();
    const headers = (fetchMock.mock.calls[0][1] as RequestInit)?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
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

  it("rescheduleTask() PATCHes the task id with the patch body", async () => {
    const fetchMock = mockFetchOnce(200, { task: { id: "ABC123", dueDate: "2026-12-01" } });
    await api.rescheduleTask("ABC123", { dueDate: "2026-12-01", dueTime: "09:30" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/tasks/ABC123");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      dueDate: "2026-12-01",
      dueTime: "09:30",
    });
  });

  it("rescheduleTask() sends explicit nulls to clear date/time", async () => {
    const fetchMock = mockFetchOnce(200, { task: { id: "ABC123", dueDate: null } });
    await api.rescheduleTask("ABC123", { dueDate: null });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ dueDate: null });
  });

  it("createTask() forwards an optional dueTime", async () => {
    const fetchMock = mockFetchOnce(200, { task: { id: "X" } });
    await api.createTask("Dentist", "2026-12-01", "09:30");
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent).toEqual({ title: "Dentist", dueDate: "2026-12-01", dueTime: "09:30" });
  });

  it("deleteDocument() DELETEs by id with no JSON content-type (Fastify 400s an empty JSON body)", async () => {
    const fetchMock = mockFetchOnce(200, { document: { id: "DOC1" } });
    await api.deleteDocument("DOC1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/documents/DOC1");
    expect((init as RequestInit).method).toBe("DELETE");
    expect((init as RequestInit).body).toBeUndefined();
    expect((init as RequestInit).headers).toBeUndefined();
  });

  it("searchDocuments() GETs /documents/search with the query, mode, and filters", async () => {
    const fetchMock = mockFetchOnce(200, { results: [] });
    await api.searchDocuments("car cover renewal", { mode: "semantic", category: "insurance", limit: 12 });
    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(String(url), "http://x");
    expect(u.pathname).toBe("/documents/search");
    expect(u.searchParams.get("q")).toBe("car cover renewal");
    expect(u.searchParams.get("mode")).toBe("semantic");
    expect(u.searchParams.get("category")).toBe("insurance");
    expect(u.searchParams.get("limit")).toBe("12");
    expect((init as RequestInit)?.method ?? "GET").toBe("GET");
  });

  it("searchDocuments() omits mode when not given", async () => {
    const fetchMock = mockFetchOnce(200, { results: [] });
    await api.searchDocuments("water bill");
    const u = new URL(String(fetchMock.mock.calls[0][0]), "http://x");
    expect(u.searchParams.has("mode")).toBe(false);
    expect(u.searchParams.get("q")).toBe("water bill");
  });

  it("updateSettings() PUTs only the fields in the patch", async () => {
    const fetchMock = mockFetchOnce(200, { inboxDir: "/x", model: "m", ollamaBaseUrl: "u", ocrModel: "glm-ocr:latest" });
    await api.updateSettings({ model: "llama3.1:8b", ollamaBaseUrl: "http://10.0.0.2:11434" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/settings");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      model: "llama3.1:8b",
      ollamaBaseUrl: "http://10.0.0.2:11434",
    });
  });

  it("chat() sends message only when there are no images", async () => {
    const fetchMock = mockFetchOnce(200, { reply: "hi" });
    await api.chat("hello");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ message: "hello" });
  });

  it("chat() includes images when attached", async () => {
    const fetchMock = mockFetchOnce(200, { reply: "a cat" });
    await api.chat("what is this?", ["data:image/jpeg;base64,AAAA"]);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      message: "what is this?",
      images: ["data:image/jpeg;base64,AAAA"],
    });
  });

  it("chat() forwards an AbortSignal so the caller can cancel it", async () => {
    const fetchMock = mockFetchOnce(200, { reply: "hi" });
    const controller = new AbortController();
    await api.chat("hello", [], controller.signal);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  it("transcribe() POSTs the clip as multipart to /transcribe without a JSON content-type", async () => {
    setToken("tok-voice");
    const fetchMock = mockFetchOnce(200, { text: "buy milk tomorrow" });
    const res = await api.transcribe(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }));
    expect(res).toEqual({ text: "buy milk tomorrow" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/transcribe");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    expect(((init as RequestInit).body as FormData).get("audio")).toBeInstanceOf(Blob);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-voice");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("listOllamaModels() GETs /ollama/models", async () => {
    const fetchMock = mockFetchOnce(200, { models: ["gemma4:e2b"], reachable: true });
    const res = await api.listOllamaModels();
    expect(res).toEqual({ models: ["gemma4:e2b"], reachable: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/ollama/models");
  });

  it("retryExtraction() POSTs the retry path with no body or content-type", async () => {
    const fetchMock = mockFetchOnce(200, { document: { id: "DOC1", extractionStatus: "pending" } });
    await api.retryExtraction("DOC1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/documents/DOC1/retry-extraction");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toBeUndefined();
  });

  it("renameDocument() PATCHes /documents/:id with the filename and source", async () => {
    const fetchMock = mockFetchOnce(200, { document: { id: "DOC1", filename: "Water Bill.pdf" } });
    await api.renameDocument("DOC1", "Water Bill.pdf", "document-agent");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/documents/DOC1");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      filename: "Water Bill.pdf",
      by: "document-agent",
    });
  });

  it("renameDocument() defaults the source to 'user'", async () => {
    const fetchMock = mockFetchOnce(200, { document: { id: "DOC1", filename: "x" } });
    await api.renameDocument("DOC1", "x");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      filename: "x",
      by: "user",
    });
  });

  it("suggestDocumentName() POSTs /documents/:id/suggest-name", async () => {
    const fetchMock = mockFetchOnce(200, { suggestion: { filename: "Blue Cross EOB.pdf" }, current: "scan.pdf" });
    const res = await api.suggestDocumentName("DOC1");
    expect(res.suggestion.filename).toBe("Blue Cross EOB.pdf");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/documents/DOC1/suggest-name");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("searchDocuments() builds a query string with q and filters", async () => {
    const fetchMock = mockFetchOnce(200, { results: [] });
    await api.searchDocuments("water bill", { category: "bill", dueBefore: "2026-10-01" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/documents/search?");
    expect(url).toContain("q=water+bill");
    expect(url).toContain("category=bill");
    expect(url).toContain("dueBefore=2026-10-01");
  });

  it("searchTasks() passes q and an optional status", async () => {
    const fetchMock = mockFetchOnce(200, { results: [] });
    await api.searchTasks("registration", { status: "open" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/tasks/search?");
    expect(url).toContain("q=registration");
    expect(url).toContain("status=open");
  });

  it("createChannel() posts kind + memberIds", async () => {
    const fetchMock = mockFetchOnce(200, { channel: { id: "c1" } });
    await api.createChannel({ kind: "dm", memberIds: ["u2"] });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ kind: "dm", memberIds: ["u2"] });
  });

  it("postMessage() sends the body and mentionAgent flag", async () => {
    const fetchMock = mockFetchOnce(200, { message: { id: "m1" } });
    await api.postMessage("c1", "@agent hi", true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/channels/c1/messages");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ body: "@agent hi", mentionAgent: true });
  });

  it("listMessages() adds an after cursor when given", async () => {
    const fetchMock = mockFetchOnce(200, { messages: [] });
    await api.listMessages("c1", "2026-09-02T00:00:00.000Z");
    expect(String(fetchMock.mock.calls[0][0])).toContain("after=2026-09-02T00%3A00%3A00.000Z");
  });

  it("createNote() / listNotes() hit /notes with the scope", async () => {
    const post = mockFetchOnce(200, { note: { id: "n1" } });
    await api.createNote("shared", "buy milk", "mint");
    expect(JSON.parse((post.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
      scope: "shared",
      text: "buy milk",
      color: "mint",
    });
    vi.unstubAllGlobals();
    const get = mockFetchOnce(200, { notes: [] });
    await api.listNotes("private");
    expect(String(get.mock.calls[0][0])).toContain("/notes?scope=private");
  });

  it("createNote() forwards a position; updateNote() sends x/y for a drag", async () => {
    const post = mockFetchOnce(200, { note: { id: "n1" } });
    await api.createNote("shared", "", "sky", { x: 40, y: 60 });
    expect(JSON.parse((post.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      scope: "shared",
      text: "",
      color: "sky",
      x: 40,
      y: 60,
    });
    vi.unstubAllGlobals();
    const patch = mockFetchOnce(200, { note: { id: "n1" } });
    await api.updateNote("n1", { x: 200, y: 150 });
    const [url, init] = patch.mock.calls[0];
    expect(String(url)).toContain("/notes/n1");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ x: 200, y: 150 });
  });

  it("chat() surfaces references from the response", async () => {
    mockFetchOnce(200, { reply: "here", references: [{ type: "document", id: "d1", label: "bill.txt" }] });
    const res = await api.chat("what's the bill");
    expect(res.references?.[0]).toMatchObject({ type: "document", id: "d1" });
  });
});
