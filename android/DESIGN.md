# Android UI — style reference

> **The Android app now follows the repo-root `DESIGN.md`** ("Notion — warm
> paper notebook") plus the desktop's **Gemini-inspired atmosphere layer**. It
> converged onto the desktop look on 2026-09-07 — the earlier standalone
> "Playful Color Mobile Design System" (indigo/pink/cyan, Nunito, light + dark)
> is retired. This file records the Android-specific mapping; the palette,
> type scale, spacing and component rules live in the root `DESIGN.md` and its
> "Desktop atmosphere layer (Gemini-inspired)" section.

Android tokens live in
`android/app/src/main/kotlin/app/familyagent/android/ui/theme/Theme.kt`
(colour scheme, `AppAccents`, typography, shapes) and
`android/app/src/main/res/values/colors.xml` (window background — light only,
no `-night`).

## What matches the desktop

| Aspect | Value |
|---|---|
| Canvas | `#f6f5f4` warm paper |
| Card surface | `#ffffff`, hairline border `rgba(0,0,0,0.08)`, soft float shadow |
| Accent | `#0075de` blue — the one chromatic commitment (filled buttons, active nav, links, chips) |
| Accent soft | `#e6f3fe` — ghost buttons, active nav background, segmented-toggle fill |
| Text | `#000000` with alpha hierarchy (95 / 60 / 40); graphite `#615d59` for body |
| Type | **Inter** everywhere (`res/font/inter_variable.ttf`); **Source Serif 4** only for `ScreenScaffold` subtitles (the editorial `.view-sub` voice) |
| Shape | buttons ~12–16, cards ~16, sheets ~20–26 (`AppShapes`) |
| Theme | **light only** — `FamilyAgentTheme` never consults `isSystemInDarkTheme()`; there is no dark palette or `values-night/` |

## Atmosphere layer on Android

The Android counterpart of the desktop's `body::before` / `body::after` bloom
layers:

- **`ui/Atmosphere.kt` — `AtmosphereBackground`.** Wraps the whole app (in
  `MainActivity`, around the auth `when`). Draws the warm paper base plus four
  soft radial colour blooms (sky / peach / lilac / mint, from `AppAccents.bloom*`)
  that drift on sine waves via a 34 s `rememberInfiniteTransition`. Frozen when
  the OS `ANIMATOR_DURATION_SCALE` is 0 (the platform "remove animations"
  setting).
- **No glass, opaque surfaces.** The desktop's glass chrome relies on
  `backdrop-filter: blur()`, which Compose can't do cheaply (pre-Android-12).
  A flat translucent surface with no blur just shows a distracting ghost of
  whatever is behind it, so the drawer, the floating menu button, the chat/
  messages composers, and every card are **opaque `surface`**. They still
  "float" over the animated gradient the way the desktop cards do — via their
  shadow + rounded corners, with the wash showing in the gutters between them.
- **Transparent screens.** `Scaffold` `containerColor = Color.Transparent`;
  `ScreenScaffold` paints no background; the conversation screen dropped its
  solid fill — so the wash shows around and between the floating cards.
- **Floating cards.** `AppCard` keeps its shadow + hairline border; the Board
  panel and the chat composers gained a shadow + border + white fill.
- **Springy nav.** `NavHost` `enterTransition` / `exitTransition` — a small
  horizontal slide + fade on the `tween` curves.

## Navigation

Chat is the home surface, a `ModalNavigationDrawer` switches views. **There is
no app bar** — it was removed (the persistent wordmark + divider ate ~56dp for
little value). A single **floating menu button** (top-left, white glass,
`statusBarsPadding()` + 6dp) opens the drawer; `ScreenScaffold` reserves 58dp
of top space for it. The button is hidden on the tool WebView and inside a
conversation, which have their own top-left back/close controls. The active
drawer item uses the desktop's `accent-soft` background + `accent` text/icon
(was a filled indigo pill).

The **Vault** drawer item (`Destination.Vault`, `ui/VaultScreen.kt`) appears
only when `/health.vault == "on"` — same gating pattern as Routines / Skills /
Connections. It's a lock gate (`AppCard` with a password field) → an entry list
of `AppCard`s → a `ModalBottomSheet` detail (reveal / copy / ticking 2FA) and a
second sheet for the add/edit form, reusing `DetailSheet.kt`'s pattern. All
crypto is server-side; the screen only ever holds decrypted values while the
vault is unlocked. See `docs/DECISIONS.md` → "Password vault".

**Generated cards** (`ui/CardWebView.kt`) render inline in `ChatBubble` /
`MessageBubble` when a reply carries one and `/health.cards == "on"`: a card
chrome (`Surface` + "✨" badge + "Code" → `DetailContent.CardSource` sheet)
around an isolated `WebView` — `loadDataWithBaseURL(null, …)` for an opaque
origin, all network killed at `shouldInterceptRequest`, height via a single
`@JavascriptInterface`, animated with `animateDpAsState`, "Show all" past a
520 dp clamp. The Settings screen gains a `Switch` for the machine-wide
toggle (`GET/PUT /settings`, admin + env-lock gated). See `docs/DECISIONS.md`
→ "AI-generated HTML cards".

## Nunito

`res/font/nunito_variable.ttf` is still bundled but no longer referenced — kept
in case the Playful direction is ever revisited. Safe to delete.
