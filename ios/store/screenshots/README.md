# Screenshots

## What App Store Connect needs

- **iPhone 6.9" Display** is the only required size. Upload the six PNGs in
  `6.9-inch/`; App Store Connect reuses them for the 6.5" and 5.5" slots.
- 1–10 per size. We have 6, each with real content (no empty states).
- Exact pixels: **1320 × 2868** portrait. All six files are already this size
  (verified with `sips`), captured on an **iPhone 17 Pro Max** simulator.
- PNG, RGB, no alpha, no added device frame or rounded corners.
- **No iPad** — the app is iPhone-only (`TARGETED_DEVICE_FAMILY = 1`).
- Do **not** substitute the 1206×2622 captures used on the landing page — that's
  the 6.3" class and App Store Connect rejects it for this slot.

## Upload order

App Store Connect shows them in upload order. Lead with the assistant:

| # | File            | Screen    |
|---|-----------------|-----------|
| 1 | `chat.png`      | Chat — the assistant answering, with the tool calls it made |
| 2 | `events.png`    | Events — the week, built from things mentioned in passing |
| 3 | `documents.png` | Documents — filed paperwork, searchable by meaning |
| 4 | `routines.png`  | Routines — a scheduled instruction the assistant runs itself |
| 5 | `board.png`     | Board — the shared sticky board |
| 6 | `vault.png`     | Vault — passwords and 2FA codes, encrypted at rest |

These are plain device captures with no text overlays — that's allowed. If you
later add marketing captions, keep the originals: Apple requires the screenshot
to represent the actual app and flags heavily framed images.

## ⚠️ Recapture `board.png` before a public submission

`board.png` caught a **system notification banner** ("Ready for Apple
Intelligence") across the top, covering the "Board" title. Apple routinely
rejects screenshots showing system notifications. The other five are clean
(9:41 status bar, full bars, charged, no notifications).

## How these were captured / how to redo them

`.claude/skills/update-landing-page/capture/capture-ios.sh` scripts it — point it
at a Pro Max simulator and it produces this exact size:

```bash
# 1. a seeded agent-core reachable at localhost:4173 (vault enabled), e.g. via
#    .claude/skills/update-landing-page/capture/capture-desktop.sh
# 2. a Debug FamilyAgent.app built (./scripts/start-ios.sh once)
# 3. quiet the status bar on the booted sim:
xcrun simctl status_bar booted override \
  --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
# 4. capture (just the one screen, or omit for all six):
.claude/skills/update-landing-page/capture/capture-ios.sh \
  ios/store/screenshots/6.9-inch board
```

The script uses the DEBUG launch hooks (`FA_SERVER_URL` / `FA_AUTOLOGIN` /
`FA_START`, and `FA_CHAT_PROMPT` for `chat.png`) to land directly on a screen
with content. Turn off Apple-Intelligence / system banners on the sim first, or
just retry until a capture lands clean.

## How these were captured

`agent-core` on port **4373** against the seeded `/tmp/fa-ios` data with
`FAMILY_AGENT_VAULT=1`, so the Vault screen has entries. Port 4373 rather than
the default, so the installed `Family Agent.app` sidecar on 4173 was never
touched.

```
simctl status_bar <sim> override --time 9:41 --batteryState charged \
  --batteryLevel 100 --cellularBars 4 --wifiBars 3
SIMCTL_CHILD_FA_SERVER_URL=http://localhost:4373 \
SIMCTL_CHILD_FA_AUTOLOGIN=dad:testpass \
SIMCTL_CHILD_FA_START=<screen> simctl launch --terminate-running-process <sim> app.familyagent.ios
simctl io <sim> screenshot <screen>.png
```

`chat.png` additionally used `FA_CHAT_PROMPT` so the transcript shows a real
answer from the local model instead of the empty state — worth redoing that way
if you ever recapture, since an empty Chat screen is a weak lead image.

Those `FA_*` hooks are `#if DEBUG`, so this needs a Debug build.
`.claude/skills/update-landing-page/capture/capture-ios.sh` scripts the same
approach; point it at a Pro Max simulator to get this size.

`xcrun` will not find `simctl` while `xcode-select -p` points at
CommandLineTools — use the full path
`/Applications/Xcode.app/Contents/Developer/usr/bin/simctl`, or repoint it.

## Two things that ruined a capture run

**System notification banners.** A first run caught *"Ready for Apple
Intelligence"* across the top of `board.png`, covering the title. Simulator
banners appear shortly after boot and are not affected by `status_bar override`.
Boot, wait ~45s for them to clear, and only then capture. Always review the set
before uploading — a contact sheet makes this one glance instead of six.

**Other apps on the simulator.** The iPhone 17 Pro Max simulator had an unrelated
app installed and a pending link prompt (*"Open in TinyTaps?"*) that appeared
over the app, and in one run stole the foreground entirely so the screenshot
captured a different app altogether. `chat.png` was therefore captured on the
**iPhone 16 Pro Max** simulator, which is clean and the same 6.9" / 1320×2868.
Prefer a simulator with nothing else installed; don't `simctl erase` one that
holds someone's other work.

Known cosmetic nit: `chat.png`'s battery icon is not the green charging state the
other five have — `--batteryState charged` didn't take on that device. Harmless,
but re-shoot it if you want the set perfectly uniform.
