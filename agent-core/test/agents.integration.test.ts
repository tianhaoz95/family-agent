import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";

// Real end-to-end tests against the local Ollama model (gemma4:e2b by
// default). These are slow — gemma4:e2b is a larger multimodal model and a
// full planner turn on CPU has taken ~110s in testing — and are skipped
// automatically if the model isn't reachable, so the fast unit tests still
// pass in an environment without Ollama set up. See docs/BUILD_LOG.md for
// the last recorded run against a live model.
async function modelIsReady(): Promise<boolean> {
  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/tags`);
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: { name: string }[] };
    return !!body.models?.some((m) => m.name === config.model || m.name === `${config.model}:latest`);
  } catch {
    return false;
  }
}

const ready = await modelIsReady();
const maybe = ready ? describe : describe.skip;

maybe("family agent (live model: " + config.model + ")", () => {
  let app: FastifyInstance;
  let store: Store;

  beforeAll(() => {
    store = new Store(":memory:");
    app = buildServer(store);
  });

  it(
    "creates a task from a natural-language request via /chat",
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { message: "Please add a task to renew the car registration by 2026-11-01." },
      });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().reply).toBe("string");

      const tasks = store.listTasks();
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    },
    240000
  );

  it(
    "extracts fields from an ingested document",
    async () => {
      const ingest = await app.inject({
        method: "POST",
        url: "/documents/ingest",
        payload: {
          filename: "electric-bill.txt",
          text: "City Power & Light — Account #4471. Amount due: $86.40. Due date: 2026-10-05.",
        },
      });
      expect(ingest.statusCode).toBe(200);
      const docId = ingest.json().document.id;

      // Extraction runs asynchronously (see server.ts); poll for it.
      let extracted: unknown = null;
      for (let i = 0; i < 60; i++) {
        const doc = store.getDocument(docId);
        if (doc?.extracted) {
          extracted = doc.extracted;
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }

      expect(extracted).not.toBeNull();
    },
    240000
  );

  it(
    "answers 'what documents do I have' correctly once one exists",
    async () => {
      // Regression test: this exact prompt returned "I found no documents"
      // against a real ingested document before list_documents existed.
      const ingest = await app.inject({
        method: "POST",
        url: "/documents/ingest",
        payload: { filename: "insurance-note.txt", text: "Auto insurance renews 2026-12-01, premium $410." },
      });
      const docId = ingest.json().document.id;
      for (let i = 0; i < 60; i++) {
        if (store.getDocument(docId)?.extracted) break;
        await new Promise((r) => setTimeout(r, 3000));
      }

      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { message: "What documents do I have?" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().reply.toLowerCase()).toContain("insurance-note");
    },
    240000
  );
});

if (!ready) {
  describe("family agent (live model)", () => {
    it.skip(`skipped: ${config.model} not available at ${config.ollamaBaseUrl}`, () => {});
  });
}
