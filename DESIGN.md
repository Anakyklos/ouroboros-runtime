# 🐍 Ouroboros Design System
> **Status: Legacy** — Classificado em [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md).
> Este design system pertence à TUI React/Ink legada (classificação: RETIRE/DEFER,
> itens 20/24 da matriz). A direção do produto é daemon headless + Mission Control
> desktop + CLI (#70). Não use este documento como guia de identidade visual vigente.
>
> **Current/Direction/Legacy**: ver [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

> **"Elegant, Sophisticated, Serpentine"**

This guide ensures visual consistency across the Ouroboros TUI.

---

## Color Palette

Inspired by the snake (🐍) - elegant greens, luxurious golds, deep obsidian.

| Token            | Hex       | Usage                          |
|------------------|-----------|--------------------------------|
| `emerald`        | `#10B981` | Primary accent, success states |
| `emeraldMuted`   | `#059669` | Secondary text, borders        |
| `emeraldDark`    | `#047857` | Hover states, subtle accents   |
| `gold`           | `#F59E0B` | Highlights, warnings, prompts  |
| `goldBright`     | `#FBBF24` | Intense highlights, progress   |
| `obsidian`       | `#0F172A` | Background primary             |
| `slate`          | `#1E293B` | Background secondary, panels   |
| `pearl`          | `#F8FAFC` | Primary text                   |
| `silver`         | `#94A3B8` | Muted text, timestamps         |
| `ruby`           | `#EF4444` | Errors                         |

---

## Typography Hierarchy

| Element       | Style                     | Color     |
|---------------|---------------------------|-----------|
| Banner/Logo   | ASCII Art, bold           | emerald   |
| Headers       | ALL CAPS, bold            | gold      |
| System text   | Regular                   | silver    |
| User text     | Bold                      | pearl     |
| Agent text    | Italic or regular         | emerald   |
| Timestamps    | Dim                       | silver    |
| Errors        | Bold                      | ruby      |

---

## Component Patterns

### Prompt
```
🐍 ›
```
- Emoji: 🐍 (emerald glow)
- Symbol: › (gold)
- Input: pearl

### Messages

**User:**
```
⚡ You: message content here
```
- Icon: ⚡ (gold)
- Label: "You:" bold (pearl)
- Content: pearl

**Agent:**
```
🐍 Ouroboros: response here
```
- Icon: 🐍 (emerald)
- Label: "Ouroboros:" (emeraldMuted)
- Content: pearl

**System:**
```
ℹ system message
```
- Icon: ℹ (silver)
- Content: silver/muted

### Status Indicators

| Status     | Visual                    |
|------------|---------------------------|
| idle       | `🐍 Ready`                |
| thinking   | `💭 Thinking...` (pulse)  |
| executing  | `⚡ Executing...` (spin)  |
| error      | `❌ Error`                |

---

## Banner (Startup)

```
   ██████╗ ██╗   ██╗██████╗  ██████╗ ██████╗  ██████╗ ██████╗  ██████╗ ███████╗
  ██╔═══██╗██║   ██║██╔══██╗██╔═══██╗██╔══██╗██╔═══██╗██╔══██╗██╔═══██╗██╔════╝
  ██║   ██║██║   ██║██████╔╝██║   ██║██████╔╝██║   ██║██████╔╝██║   ██║███████╗
  ██║   ██║██║   ██║██╔══██╗██║   ██║██╔══██╗██║   ██║██╔══██╗██║   ██║╚════██║
  ╚██████╔╝╚██████╔╝██║  ██║╚██████╔╝██████╔╝╚██████╔╝██║  ██║╚██████╔╝███████║
   ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
```
- Color: Gradient emerald → gold
- Subtitle: "🐍 Autonomous Agent Runtime" (silver)

---

## Do's & Don'ts

### ✅ Do
- Use emerald for agent/success feedback
- Use gold sparingly for emphasis
- Keep backgrounds dark (obsidian/slate)
- Animate subtly (spinners, not flashes)
- Maintain generous spacing

### ❌ Don't
- Use bright whites (prefer pearl)
- Mix too many colors in one message
- Use aggressive animations
- Clutter the interface with borders
