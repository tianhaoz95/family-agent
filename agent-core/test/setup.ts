import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the whole suite from the developer's real ~/.local/share/family-agent.
// `config.ts` reads persisted settings and derives every on-disk path from
// `dataDir` at import time, so without this a machine with a saved model / Ollama
// URL fails the /health assertions, and tests that store files (uploaded
// document originals) would write into the real data directory. Set before any
// `src/` module is imported — setupFiles run before the test files load.
process.env.FAMILY_AGENT_DATA_DIR ??= mkdtempSync(join(tmpdir(), "family-agent-test-"));

// Semantic search calls a live Ollama embedding model on the ingest path and
// at startup. The fast unit + route suites must not depend on that, so the
// feature is off by default here — the tests that exercise it turn it back on
// explicitly (embeddings.test.ts) or self-skip when the model is unreachable
// (semanticSearch.integration.test.ts). Keyword + trigram-fuzzy search need no
// model and stay on.
process.env.FAMILY_AGENT_EMBED ??= "0";
