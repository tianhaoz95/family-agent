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
