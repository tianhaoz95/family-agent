# Playful Color Mobile Design System

> This is the design system for the **Android app only**. The desktop app and
> `agent-core`-served tool pages still follow the repo-root `DESIGN.md`
> ("Notion — warm paper notebook"). The two are intentionally different now;
> there is no shared token file between them.
>
> Android tokens live in
> `android/app/src/main/kotlin/app/familyagent/android/ui/theme/Theme.kt`
> (colour schemes, `AppAccents`, typography, shapes) and
> `android/app/src/main/res/values{,-night}/colors.xml` (window background).

## 1. Design Principles

* Playful, vibrant, and expressive
* Friendly and approachable visual language
* Use color as a primary communication tool
* Soft shapes, rounded corners, and lively spacing
* Encourage exploration and engagement
* Designed for consumer-facing, high-retention apps

---

## 2. Color System

### 2.1 Light Mode (Primary)

* Primary: #6366F1 (indigo)
* Secondary: #F472B6 (pink)
* Accent: #22D3EE (cyan)
* Background: #FFFFFF
* Surface: #F8FAFC
* Surface Alt: #EEF2FF
* Text Primary: #0F172A
* Text Secondary: #64748B
* Border: #E2E8F0
* Success: #22C55E
* Warning: #F59E0B
* Error: #EF4444

### 2.2 Dark Mode

* Primary: #818CF8
* Secondary: #F9A8D4
* Accent: #67E8F9
* Background: #0B0F14
* Surface: #111827
* Surface Alt: #1F2937
* Text Primary: #F8FAFC
* Text Secondary: #94A3B8
* Border: #1F2937

### 2.3 Rules

* Use multiple accent colors, but limit to 2–3 per screen
* Color should guide user attention
* Avoid overly muted palettes
* Maintain contrast even with vibrant colors

---

## 3. Typography

* Font Family:

  * iOS: System (San Francisco)
  * Android: Roboto
  * Optional: rounded font (e.g. Nunito, Inter Rounded)

  This app bundles **Nunito** (`res/font/nunito_variable.ttf`, no CDN) for the
  rounded, friendly feel.

### Scale

* Large Title: 30 / Bold
* Title: 22 / SemiBold
* Body: 16 / Regular
* Caption: 13 / Regular
* Small: 11 / Medium

### Rules

* Slightly larger typography for friendliness
* Use bold text for emphasis
* Avoid overly dense text blocks
* Line height: 1.5 – 1.6

---

## 4. Spacing System

Base unit: 4

* xs: 4
* sm: 8
* md: 12
* lg: 16
* xl: 24
* xxl: 32

### Rules

* Use generous spacing to create a relaxed feel
* Avoid tight layouts
* Prefer breathing room between sections

---

## 5. Layout & Safe Area

* Respect safe area
* Default padding: 16–20
* Use section-based layout
* Avoid edge-to-edge dense content

---

## 6. Touch & Interaction

* Minimum touch target:

  * iOS: 44pt
  * Android: 48dp

* Feedback:

  * Scale: 0.96–0.98
  * Bounce effect allowed

* Interaction should feel lively and responsive

---

## 7. Navigation Patterns

* Tab + Stack hybrid

  This app uses **chat as the home surface + a collapsible left sidebar
  drawer** (see `MainActivity.kt`) rather than a bottom tab bar — a product
  decision that predates this design system. The drawer follows the
  expressive-nav rules below: colorful active state, filled/rounded icons,
  rounded container.

### Tab Bar

* Colorful active state
* Icons can be filled when active
* Rounded container optional

### Stack

* Bright headers or colored backgrounds allowed
* More expressive transitions acceptable

---

## 8. Components

### 8.1 Button

Variants:

* Primary (filled)
* Secondary (soft filled)
* Outline

Rules:

* Height: 44–48
* Radius: 16–20 (more rounded)
* Use color for hierarchy
* Allow gradient backgrounds (optional)

---

### 8.2 Card

* Background: Surface or Surface Alt
* Radius: 16–20
* Padding: 16–20
* Optional: colored top bar or accent

  `AppCard` in `ui/Components.kt` — soft shadow (3dp), 20 radius, 18 padding,
  optional `accent` top strip, optional bouncy `onClick`.

---

### 8.3 List Item

* Height: 60–72
* Use icons or illustrations
* Minimal dividers
* Use spacing and color separation instead

---

### 8.4 Input

* Background: Surface
* Radius: 14–18
* Border: soft
* Focus: colored highlight
* Placeholder: friendly tone

---

## 9. Motion

* Duration: 200–350ms

### Style

* Playful and dynamic
* Spring animations encouraged
* Micro-interactions highly encouraged

---

## 10. Elevation & Depth

* Use soft shadows
* Cards should feel slightly lifted
* Avoid flat, rigid layouts

---

## 11. Iconography

* Rounded and friendly icons (`Icons.Rounded.*` / `Icons.AutoMirrored.Rounded.*`)
* Slightly thicker strokes allowed
* Sizes:

  * Small: 16
  * Default: 22–24
  * Large: 28–32

---

## 12. Accessibility

* Ensure color contrast despite vibrant palette
* Avoid relying solely on color for meaning
* Support dynamic type scaling

---

## 13. Platform Adaptation

### iOS

* More playful animations allowed
* Smooth transitions

### Android

* Slightly reduce animation intensity
* Keep performance in mind

---

## 14. Do / Don't

### Do

* Use color intentionally
* Keep UI fun and engaging
* Maintain consistency across components

### Don't

* Overuse too many colors at once
* Mix conflicting color palettes
* Make UI visually overwhelming
