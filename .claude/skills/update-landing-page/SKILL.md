---
name: update-landing-page
description: Update the Family Agent landing page, privacy or support pages in site/ — refresh app screenshots, change copy or layout, or fix the download link after a release. Use when asked to change anything under site/, or when a release makes the site out of date.
---

# Updating the landing page

The site is `site/` — plain HTML and CSS, no build step. `.github/workflows/pages.yml`
deploys it to <https://tianhaoz95.github.io/family-agent/> on every push to `main`
that touches `site/`.

```
site/
  index.html     landing page
  privacy.html   privacy policy   ← App Store requires this URL to exist
  support.html   support page     ← App Store requires this URL to exist
  style.css      all three
  img/           screenshots + logo
```

Privacy and support are **not optional**. They are mandatory fields on the App
Store listing; deleting or breaking them breaks a submission.

## Ground rules

**The palette and type are the app's own**, from `DESIGN.md` / `ios/.../Theme.swift`:
warm paper `#f6f5f4`, one accent `#0075de`, Inter with Source Serif for the
editorial voice, and the same four-bloom atmosphere the apps use. Don't invent a
separate visual language for the site — it should look like the product.

**Design both themes.** `style.css` defines light tokens on `:root` and
redefines them under `@media (prefers-color-scheme: dark)`. Anything new must
take its colours from those tokens, never a literal.

**Never ship a claim you haven't checked.** The download button pointed at
`/releases/latest` for a while when the repo had zero releases — GitHub serves
that as a **200 empty page**, not a 404, so it looked fine and silently did
nothing. Verify links resolve *and* return what you expect.

## Verifying a change

`screencapture` is blocked by the Screen Recording permission on this machine,
so look at the page through WebKit instead:

```bash
R=.claude/skills/update-landing-page/capture/render-web.swift
swift "$R" "$PWD/site/index.html" /tmp/page.png --width 1280 --height 900   # desktop
swift "$R" "$PWD/site/index.html" /tmp/narrow.png --width 430 --height 900  # phone
swift "$R" "https://tianhaoz95.github.io/family-agent/" /tmp/live.png       # published
```

Pass an **absolute** path for local files. Then read the PNG to actually look at
it — don't assume.

After pushing, confirm the deploy and that assets really serve:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://tianhaoz95.github.io/family-agent/
curl -s -o /dev/null -w '%{http_code}\n' https://tianhaoz95.github.io/family-agent/img/<new>.jpg
```

## Refreshing screenshots

### Phone

```bash
.claude/skills/update-landing-page/capture/capture-ios.sh /tmp/shots chat events documents
sips -Z 880 -s format jpeg -s formatOptions 84 /tmp/shots/events.png --out site/img/events.jpg
```

Needs a booted simulator, a Debug build (the `FA_*` launch hooks are
`#if DEBUG`), and an agent-core with real content at `localhost:4173`. Empty
screens make a bad hero — seed data first.

### Desktop

```bash
.claude/skills/update-landing-page/capture/capture-desktop.sh /tmp/desk.png
sips -Z 1300 -s format jpeg -s formatOptions 86 /tmp/desk.png --out site/img/desktop-chat.jpg
```

It starts agent-core on **its own ports (4273/4274)** and Vite pointed at it via
`VITE_API_BASE`, renders the real frontend signed in, and stops both. The port
isolation matters: the installed `Family Agent.app` keeps a sidecar on 4173 with
the real household's accounts, and reusing it fails to log in.

Capture at **1120x720**, not 1440x900 — a 1440px UI scaled into the hero is
unreadable; the tighter viewport keeps the interface proportionally larger.

`FA_CAPTURE_DATA_DIR` picks the data directory (default `/tmp/fa-capture`, and a
fresh one is bootstrapped automatically). Seed it with content first if you want
populated screens — empty views make a bad hero. Vite is pinned to 1420 with
`strictPort`, so stop any running `npm run tauri:dev` before capturing.

### Two traps, both already handled by the tools

- **Everything renders blank.** An offscreen WKWebView never ticks CSS
  transitions, so the desktop app's views sit frozen at `opacity: 0` /
  `translateY(14px)` with content correctly laid out and completely invisible.
  `render-web.swift` injects a stylesheet that kills transitions and forces
  `.view.is-active` to its settled state.
- **Images come back blank.** Injecting that global `*` rule forces a full
  restyle; snapshotting in the same turn catches the document mid-repaint. The
  tool waits a beat after injection. If you add another injection point, wait
  after it too.
- **Background processes outlive the script.** `node` and Vite fork, so the pid
  from `$!` is not the process holding the socket. `capture-desktop.sh` cleans up
  by port, not by pid — an earlier version left agent-core running afterwards.

Pass local files to `render-web.swift` as **absolute** paths; a relative one
breaks `allowingReadAccessTo` and the images silently fail to load.

## Device frames

Screenshots sit in CSS bezels (`.device` for phones, `.device-mac`), not bare
`<img>` tags with a radius bolted on — that reads as a rectangle with a status
bar floating on it.

The phone radius is `border-radius: 12.2% / 5.6%`, which is **not arbitrary**:
the screens are 1206x2622 (ratio 2.174), so 12.2% of width equals 5.6% of
height, giving a circular corner at any rendered size with no per-breakpoint
values. If the source aspect ratio ever changes, recompute both numbers —
`x% / (x/2.174)%`.

The inner `img` radius is the outer radius minus the bezel width, in the same
units. Change `padding` and both radii move together.

## After a release

The hero has an HTML comment marking what to change. On the first release of a
cycle, check:

- The **download CTA** points at `/releases/latest` and that page has assets.
- The `.cta-note` under it is still true (currently: Apple silicon, macOS 12+,
  signed and notarized).
- `support.html` → "Where are the downloads?" matches reality.
- `index.html` → "What you need" still lists the right minimum OS.

## Don't

- Don't add a build step, a framework, or a CSS library. Three HTML files and
  one stylesheet is the point.
- Don't load anything from a CDN except the Google Fonts stylesheet already
  linked.
- Don't put marketing screenshots in `site/img/` that aren't real captures of
  the running app.
- Don't let `privacy.html` or `support.html` 404.
