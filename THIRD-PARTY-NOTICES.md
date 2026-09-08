# Third-party notices

This repository redistributes font binaries, and the desktop app additionally
ships a Node runtime and its native dependencies inside the packaged `.app`.
Their licences are reproduced here as those licences require.

## Fonts

These are committed to the repo **and** shipped inside the built iOS and Android
apps, so their licences travel with them.

| Font | Where | Licence |
|---|---|---|
| Inter | `ios/FamilyAgent/Resources/Fonts/Inter-Variable.ttf`, `android/app/src/main/res/font/inter_variable.ttf` | SIL Open Font License 1.1 — [`licenses/OFL-Inter.txt`](licenses/OFL-Inter.txt) |
| Source Serif 4 | `ios/FamilyAgent/Resources/Fonts/SourceSerif4-Regular.ttf`, `android/app/src/main/res/font/source_serif.ttf` | SIL Open Font License 1.1 — [`licenses/OFL-SourceSerif4.txt`](licenses/OFL-SourceSerif4.txt) |

The desktop app loads Inter and Source Serif from the `@fontsource` npm
packages rather than committed binaries; those carry their own licence files in
`node_modules`.

## Bundled runtime (desktop app only)

The packaged macOS/Linux desktop app embeds a Node.js runtime and the
production dependency tree of `agent-core` under `Contents/Resources/sidecar`,
including native addons: `onnxruntime-node`, `sharp` / `libvips`,
`@napi-rs/canvas`, `tesseract.js`, `@huggingface/transformers`, `kokoro-js`.
Each carries its own licence in its package directory; the licences are
distributed inside the app bundle with the code they cover.

None of this applies to the iOS or Android apps, which are pure HTTP clients and
bundle no runtime.
