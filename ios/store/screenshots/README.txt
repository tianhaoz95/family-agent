APP STORE SCREENSHOTS

6.9-inch/  1320x2868, captured on an iPhone 17 Pro Max simulator.

This is the ONLY size the listing requires. App Store Connect scales it for
every other iPhone. iPad shots are not needed: the app is iPhone-only
(TARGETED_DEVICE_FAMILY = 1).

Do not substitute the 1206x2622 captures used on the landing page — that is the
6.3-inch class and App Store Connect rejects it for this slot.

SUGGESTED ORDER  (the first two are what most people ever see)

  1. chat.png        the assistant answering, with the tool calls it made
  2. events.png      the week, built from things mentioned in passing
  3. documents.png   filed paperwork, searchable by meaning
  4. board.png       the shared sticky board
  5. vault.png       passwords and 2FA, encrypted at rest
  6. routines.png    scheduled instructions the assistant runs itself

Up to 10 are allowed; six is plenty and every one of these has real content in
it rather than an empty state.

CAPTURED WITH

  agent-core on port 4373 against the seeded /tmp/fa-ios data, vault enabled,
  status bar overridden to 9:41 / full bars / charged, then:

    simctl launch  with FA_SERVER_URL + FA_AUTOLOGIN + FA_START
    simctl io ... screenshot

  chat.png used FA_CHAT_PROMPT so the transcript shows a real answer from the
  local model rather than the empty state.

  To redo them, the same approach is scripted for the landing page in
  .claude/skills/update-landing-page/capture/capture-ios.sh — point it at a
  Pro Max simulator and it produces this size.

NO TEXT OVERLAYS

These are plain device captures. If you later add marketing captions, keep a
copy of the originals: Apple requires the screenshot to represent the actual
app, and heavily framed images get flagged.
