/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the agent-core base URL for `vite dev` / `vite preview`. */
  readonly VITE_API_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
