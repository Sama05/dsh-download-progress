/**
 * dsh-download-progress — Client half.
 *
 * Two contributions, both purely client-side (the Host half only serves data):
 *
 *  1. `shell.overlay` (scope root) — one frame-wide floating indicator, so it
 *     survives session switches and never participates in layout: nothing
 *     above it can be pushed around when it appears or disappears.
 *  2. `settings.section` (scope root) — one page in DSH Settings, following the
 *     same slot the shipped/installed plugins use. Preferences persist in
 *     localStorage (origin-scoped), so the Host half needs no change at all and
 *     nothing here depends on the shape of the settings transport service.
 *
 * All visual styling lives in the single `CSS` constant below. Changing the
 * look means editing that block only — the component tree stays untouched.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-download-progress',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/download-progress/state'
    const POLL_MS = 1000

    /* ---------------- styles (the one place UI is defined) ---------------- */

    const CSS = `
/* ---- floating overlay ---- */
.ddp-wrap{
  --ddp-rows:3;
  position:fixed;z-index:10000;pointer-events:none;
  width:min(560px,calc(100vw - 48px));
  display:flex;flex-direction:column;
  /* Default: horizontally centred, near the top. Dragging replaces these with
     explicit left/top; the inline style always wins over this rule. */
  top:76px;left:50%;transform:translateX(-50%);
  transition:top .18s ease,left .18s ease;
}
.ddp-wrap--drag{transition:none}
/* Peek outline: shows the overlay's real footprint while hovering the handle.
   outline does not take part in layout, so it cannot shift anything. */
.ddp-wrap--peek{
  outline:1px dashed var(--ddp-accent,var(--dsw-alias-brand-primary,#4c8dff));
  outline-offset:6px;border-radius:12px;
}
/* The only always-visible part: a slim grip that reveals the overlay on hover. */
.ddp-handle{
  position:relative;
  align-self:center;flex:0 0 auto;
  width:56px;height:6px;margin-bottom:6px;border-radius:999px;
  background:var(--ddp-grip,var(--dsw-alias-label-secondary,#a8a8b0));
  opacity:.22;pointer-events:auto;cursor:grab;
  transition:opacity .16s ease,width .16s ease;
}
/* The wrapper is pointer-events:none and the grip sits 6px above the card list,
   so without this the pointer crosses a dead band on its way down and the peek
   collapses mid-travel. Extend the grip's hit area across the gap (transparent,
   no visual change) so the two targets touch. */
.ddp-handle::after{
  content:'';position:absolute;
  left:-28px;right:-28px;top:-4px;bottom:-10px;
}
.ddp-handle:hover{opacity:.55;width:72px}
.ddp-wrap--peek .ddp-handle{opacity:.6}
.ddp-wrap--drag .ddp-handle{cursor:grabbing;opacity:.6}
/* Debug mode turns the grip into a labelled bar. A bare 6px, 22%-opacity line is
   effectively invisible, so switching the samples on would look like a no-op. */
.ddp-handle.ddp-handle--debug{
  width:auto;min-width:140px;height:20px;margin-bottom:8px;
  padding:0 12px;border-radius:10px;
  display:flex;align-items:center;justify-content:center;
  font-size:11px;line-height:1;letter-spacing:.2px;white-space:nowrap;
  color:var(--ddp-fg,var(--dsw-alias-label-primary,#e8e8ec));
  background:var(--ddp-chip-bg,var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14)));
  border:1px solid var(--ddp-chip-border,var(--dsw-alias-border-l1,rgba(255,255,255,.16)));
  opacity:.72;
}
.ddp-handle.ddp-handle--debug:hover{opacity:1;width:auto}
.ddp-list{
  pointer-events:auto;display:flex;flex-direction:column;gap:8px;
  /* Cards carry a log line, so one row is ~62px plus the 8px gap: budget exactly
     the requested rows instead of clipping the last card's tail. */
  max-height:calc(var(--ddp-rows) * 62px + (var(--ddp-rows) - 1) * 8px + 6px);
  overflow-y:auto;overflow-x:hidden;
  padding:2px;scrollbar-width:thin;
  cursor:grab;
}
.ddp-list:active{cursor:grabbing}
/* While dragging, text selection and hover tips would fight the gesture. */
.ddp-wrap--drag .ddp-list{cursor:grabbing;user-select:none}
.ddp-wrap--drag .ddp-tip{opacity:0 !important}
.ddp-list::-webkit-scrollbar{width:6px}
.ddp-list::-webkit-scrollbar-thumb{
  background:var(--ddp-scroll,var(--dsw-alias-scrollbar-bg-l2,rgba(255,255,255,.18)));border-radius:999px;
}
/* Enter / exit. Applied per card, not to the list: the point is that each bar
   lights up / powers down on its own, so the stack never scales as one block and
   a newly added download animates by itself without replaying the others.
   backwards fill-mode keeps the 0% frame during the stagger delay, otherwise a
   delayed card would flash in at full opacity before its animation starts. */
.ddp-anim--in.ddp-ease-float{animation:ddp-float-in .26s cubic-bezier(.2,.8,.2,1) backwards}
.ddp-anim--out.ddp-ease-float{animation:ddp-float-out .22s ease-in forwards}
.ddp-anim--in.ddp-ease-crt{animation:ddp-crt-in .34s cubic-bezier(.22,.9,.24,1) backwards}
.ddp-anim--out.ddp-ease-crt{animation:ddp-crt-out .3s ease-in forwards}
.ddp-anim--in.ddp-ease-none,.ddp-anim--out.ddp-ease-none{animation:none}
/* Ripple: the card eases up out of a slightly smaller state while a soft round
   wave spreads from its centre and fades. The wave lives on ::after and is
   clipped by the card's rounded edge, so it reads as light welling up from
   inside the glass rather than a halo floating around it. */
.ddp-anim--in.ddp-ease-ripple{animation:ddp-ripple-in .5s cubic-bezier(.16,1,.3,1) backwards}
.ddp-anim--in.ddp-ease-ripple::after{animation:ddp-ripple-wave .78s cubic-bezier(.22,.8,.3,1) backwards}
.ddp-anim--out.ddp-ease-ripple{animation:ddp-ripple-out .26s ease-in forwards}
@keyframes ddp-ripple-in{
  0%{opacity:0;transform:scale(.94)}
  60%{opacity:1;transform:scale(1.008)}
  100%{opacity:1;transform:scale(1)}
}
@keyframes ddp-ripple-wave{
  0%{opacity:0;transform:translate(-50%,-50%) scale(.12)}
  22%{opacity:.8;transform:translate(-50%,-50%) scale(.55)}
  100%{opacity:0;transform:translate(-50%,-50%) scale(2.2)}
}
@keyframes ddp-ripple-out{
  0%{opacity:1;transform:scale(1)}
  100%{opacity:0;transform:scale(.96)}
}
@keyframes ddp-float-in{
  from{opacity:0;transform:translateY(10px) scale(.985)}
  to{opacity:1;transform:translateY(0) scale(1)}
}
@keyframes ddp-float-out{
  from{opacity:1;transform:translateY(0) scale(1)}
  to{opacity:0;transform:translateY(8px) scale(.985)}
}
/* CRT power-on: a collapsed, over-bright scanline snaps open vertically, then
   overshoots slightly and settles. transform-origin stays at the centre so it
   reads as a tube lighting up rather than a panel sliding down. */
@keyframes ddp-crt-in{
  0%{opacity:0;transform:scale(.72,.004);filter:brightness(2.6) saturate(.6)}
  38%{opacity:1;transform:scale(1,.02);filter:brightness(2.2)}
  64%{transform:scale(.97,1.06);filter:brightness(1.25)}
  100%{opacity:1;transform:scale(1,1);filter:brightness(1)}
}
/* CRT power-off: reverse, with the final state being a thin bright line that
   fades — the list unmounts right after, so the last frame is never held. */
@keyframes ddp-crt-out{
  0%{opacity:1;transform:scale(1,1);filter:brightness(1)}
  45%{transform:scale(1.01,.55);filter:brightness(1.5)}
  100%{opacity:0;transform:scale(.7,.004);filter:brightness(2.8)}
}
/* Frosted glass, iOS/macOS style: the blur is what makes the card read as a
   pane of glass, so the card itself is only a light translucent tint over
   whatever sits behind it. There is deliberately no specular corner bloom —
   real glass shows a hairline of light along its top edge, nothing more. */
.ddp-card{
  position:relative;isolation:isolate;overflow:hidden;
  background:var(--ddp-card-bg,var(--dsw-alias-bg-overlay,rgba(32,32,36,.9)));
  /* With no theme override, tint the host colour down so the blur has something
     to show. Themes hand over an already-translucent value, so they win as-is. */
  background:var(--ddp-card-bg,color-mix(in srgb,var(--dsw-alias-bg-overlay,rgba(32,32,36,.9)) 74%,transparent));
  border:1px solid var(--ddp-card-border,var(--dsw-alias-border-l1,rgba(255,255,255,.10)));
  border-radius:12px;padding:8px 10px;
  /* Depth comes from four cheap tricks stacked: a contact shadow so the pane
     touches the surface instead of hovering in space, the themed ambient drop,
     a lit top edge, and a shaded bottom edge that reads as the thickness of the
     glass itself. */
  box-shadow:
    0 1px 2px rgba(0,0,0,.10),
    var(--ddp-shadow,0 8px 30px rgba(0,0,0,.30)),
    inset 0 1px 0 var(--ddp-inner-hi,rgba(255,255,255,.12)),
    inset 0 -1px 0 var(--ddp-inner-shade,rgba(0,0,0,.18));
  font-size:12px;line-height:1.45;
  color:var(--ddp-fg,var(--dsw-alias-label-primary,#e8e8ea));
  /* One variable so a theme can retune the whole material (radius, saturation,
     brightness lift) without touching this rule. */
  -webkit-backdrop-filter:var(--ddp-glass,blur(26px) saturate(185%));
  backdrop-filter:var(--ddp-glass,blur(26px) saturate(185%));
  transition:box-shadow .18s ease,transform .18s ease;
}
/* A whisper of a vertical sheen: glass catches a little more light at its top
   edge. Linear only — no radial hotspot. */
.ddp-card::before{
  content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;
  background:linear-gradient(180deg,var(--ddp-sheen,rgba(255,255,255,.06)) 0%,transparent 46%);
}
/* Ripple layer. Idle by default; only the ripple feel animates it. Clipped by
   the card's rounded edge because the card itself is overflow:hidden. */
.ddp-card::after{
  content:'';position:absolute;left:50%;top:50%;width:200%;aspect-ratio:1;
  transform:translate(-50%,-50%) scale(.12);
  border-radius:50%;pointer-events:none;opacity:0;z-index:0;
  background:radial-gradient(circle,var(--ddp-ripple,rgba(120,170,255,.26)) 0%,transparent 62%);
}
.ddp-card > *{position:relative;z-index:1}
.ddp-card:hover{
  transform:translateY(-1px);
  box-shadow:
    0 2px 5px rgba(0,0,0,.14),
    var(--ddp-shadow,0 8px 30px rgba(0,0,0,.30)),
    inset 0 1px 0 var(--ddp-inner-hi,rgba(255,255,255,.12)),
    inset 0 -1px 0 var(--ddp-inner-shade,rgba(0,0,0,.18));
}
/* While dragging the whole stack, a per-card hover lift would fight the gesture. */
.ddp-wrap--drag .ddp-card:hover{transform:none}
.ddp-row{display:flex;align-items:baseline;gap:10px}
.ddp-name{
  flex:1 1 auto;min-width:0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.ddp-meta{
  flex:0 0 auto;white-space:nowrap;
  color:var(--ddp-fg-dim,var(--dsw-alias-label-secondary,#a8a8b0));
  font-variant-numeric:tabular-nums;
}
.ddp-track{position:relative;margin-top:6px;height:5px}
.ddp-clip{
  height:100%;border-radius:999px;overflow:hidden;
  background:var(--ddp-track-bg,var(--dsw-alias-bg-layer-2,rgba(255,255,255,.13)));
}
.ddp-fill{
  position:relative;height:100%;border-radius:999px;overflow:hidden;
  /* Solid token first (older engines), then the same token at 62% alpha so the
     trough reads through the bar instead of covering it with a flat block. */
  background:var(--ddp-accent,var(--dsw-alias-brand-primary,#4c8dff));
  background:color-mix(in srgb, var(--ddp-accent,var(--dsw-alias-brand-primary,#4c8dff)) 62%, transparent);
  transition:width .45s linear;
}
.ddp-fill::after{
  content:"";position:absolute;top:0;left:-40%;width:40%;height:100%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.38),transparent);
  animation:ddp-shine 1.5s linear infinite;
}
.ddp-fill--indet{width:38%;animation:ddp-slide 1.15s ease-in-out infinite}
@keyframes ddp-slide{0%{margin-left:-38%}100%{margin-left:100%}}
@keyframes ddp-shine{0%{left:-40%}100%{left:100%}}
.ddp-tip{
  position:absolute;right:0;bottom:calc(100% + 6px);
  padding:1px 6px;border-radius:5px;font-size:11px;
  background:var(--ddp-pop-bg,var(--dsw-alias-bg-layer-3,#2a2a30));
  color:var(--ddp-fg,var(--dsw-alias-label-primary,#fff));
  border:1px solid var(--ddp-pop-border,var(--dsw-alias-border-l1,rgba(255,255,255,.14)));
  opacity:0;transition:opacity .12s;pointer-events:none;white-space:nowrap;
}
.ddp-track:hover .ddp-tip{opacity:1}
.ddp-log{
  margin-top:4px;font-size:11px;
  color:var(--ddp-fg-dim,var(--dsw-alias-label-secondary,#a8a8b0));
  opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}

/* ---- settings page ---- */
.ddp-set{display:flex;flex-direction:column;font-size:13px}
.ddp-set-row{
  display:flex;align-items:center;gap:16px;padding:11px 2px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));
}
.ddp-set-text{flex:1 1 auto;min-width:0}
.ddp-set-label{color:var(--dsw-alias-label-primary,#e8e8ea)}
.ddp-set-hint{
  margin-top:3px;font-size:12px;line-height:1.5;
  color:var(--dsw-alias-label-secondary,#a8a8b0);opacity:.85;
}
.ddp-set-ctrl{flex:0 0 auto;display:flex;align-items:center;gap:8px}
.ddp-set-check{
  width:16px;height:16px;cursor:pointer;
  accent-color:var(--dsw-alias-brand-primary,#4c8dff);
}
.ddp-set-select{
  min-width:132px;padding:4px 8px;border-radius:6px;font-size:13px;cursor:pointer;
  color:var(--dsw-alias-label-primary,#e8e8ea);
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.07));
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));
}
.ddp-set-btn{
  padding:4px 12px;border-radius:6px;font-size:13px;cursor:pointer;
  color:var(--dsw-alias-label-primary,#e8e8ea);
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.07));
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));
}
.ddp-set-btn:hover{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12))}
.ddp-set-note{  margin-top:16px;padding:10px 12px;border-radius:8px;
  font-size:12px;line-height:1.7;
  color:var(--dsw-alias-label-secondary,#a8a8b0);
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));
}
`

    /* ---------------- settings store (localStorage) ---------------- */

    const SETTINGS_KEY = 'dsh-download-progress:settings'
    const ORDERS = ['newest-first', 'oldest-first']
    const DEFAULT_Y = 76
    const DEFAULTS = {
      enabled: true,
      showSpeed: true,
      maxVisible: 3,
      order: 'newest-first',
      // Off by default: sample cards must never be mistaken for a real download.
      debugMode: false,
      theme: 'auto',
      enterAnim: 'float',
      // null x means "horizontally centred"; a number is a viewport pixel offset
      // written by dragging.
      x: null,
      y: DEFAULT_Y,
    }

    /* ---------------- theme registry ---------------- */

    // A theme is nothing but a bag of --ddp-* custom properties hung on the
    // overlay wrapper. Every colour rule in CSS reads --ddp-x with the host
    // --dsw-alias-x as its fallback, so a new theme is one object added here:
    // no new CSS, no new branch, no other file touched. The settings dropdown is
    // generated from THEMES, so it picks up additions automatically.
    const THEME_TOKENS = {
      light: {
        '--ddp-accent': '#2f7fe0',
        '--ddp-grip': '#8b8b95',
        '--ddp-fg': '#1b1b1f',
        '--ddp-fg-dim': '#5f5f68',
        // Frosted glass wants a light tint, not an opaque plate: the blur behind
        // it supplies the rest of the material.
        '--ddp-card-bg': 'rgba(255,255,255,.66)',
        '--ddp-card-border': 'rgba(0,0,0,.08)',
        '--ddp-track-bg': 'rgba(0,0,0,.10)',
        '--ddp-pop-bg': '#ffffff',
        '--ddp-pop-border': 'rgba(0,0,0,.14)',
        '--ddp-scroll': 'rgba(0,0,0,.18)',
        '--ddp-shadow': '0 2px 6px rgba(15,23,42,.07), 0 10px 34px rgba(15,23,42,.17)',
        '--ddp-inner-hi': 'rgba(255,255,255,.85)',
        '--ddp-inner-shade': 'rgba(15,23,42,.07)',
        '--ddp-glass': 'blur(26px) saturate(190%) brightness(1.04)',
        '--ddp-sheen': 'rgba(255,255,255,.42)',
        '--ddp-ripple': 'rgba(90,140,255,.24)',
        '--ddp-chip-bg': 'rgba(0,0,0,.06)',
        '--ddp-chip-border': 'rgba(0,0,0,.14)',
      },
      dark: {
        '--ddp-accent': '#4c8dff',
        '--ddp-grip': '#a8a8b0',
        '--ddp-fg': '#e8e8ea',
        '--ddp-fg-dim': '#a8a8b0',
        '--ddp-card-bg': 'rgba(30,30,34,.62)',
        '--ddp-card-border': 'rgba(255,255,255,.10)',
        '--ddp-track-bg': 'rgba(255,255,255,.13)',
        '--ddp-pop-bg': '#2a2a30',
        '--ddp-pop-border': 'rgba(255,255,255,.14)',
        '--ddp-scroll': 'rgba(255,255,255,.18)',
        '--ddp-shadow': '0 2px 6px rgba(0,0,0,.30), 0 12px 40px rgba(0,0,0,.52)',
        '--ddp-inner-hi': 'rgba(255,255,255,.17)',
        '--ddp-inner-shade': 'rgba(0,0,0,.42)',
        '--ddp-glass': 'blur(26px) saturate(185%) brightness(1.10)',
        '--ddp-sheen': 'rgba(255,255,255,.11)',
        '--ddp-ripple': 'rgba(120,170,255,.22)',
        '--ddp-chip-bg': 'rgba(255,255,255,.14)',
        '--ddp-chip-border': 'rgba(255,255,255,.16)',
      },
    }

    // 'auto' carries no tokens on purpose: every rule then falls back to the
    // host's own --dsw-alias-* values, which already track the app theme (and the
    // OS when the app follows it).
    const THEMES = [
      { id: 'auto', label: '跟随系统', tokens: null },
      { id: 'light', label: '亮色', tokens: THEME_TOKENS.light },
      { id: 'dark', label: '暗色', tokens: THEME_TOKENS.dark },
    ]

    // Enter/exit feel. Each entry maps to a `ddp-ease-<id>` class on the list
    // (visual work lives in CSS) plus the exit duration usePresence must keep
    // the node mounted for. Adding a feel is one line here plus a @keyframes
    // pair — the settings dropdown is generated from this table.
    const ENTER_ANIMS = [
      { id: 'float', label: '上浮淡入', outMs: 220 },
      { id: 'crt', label: 'CRT 开关机', outMs: 300 },
      { id: 'ripple', label: '水波纹', outMs: 260 },
      { id: 'none', label: '无动画', outMs: 0 },
    ]

    const ENTER_ANIM_IDS = ENTER_ANIMS.map((entry) => entry.id)

    /** Exit-animation length in ms; 0 means unmount immediately. */
    function enterAnimMs(id) {
      const entry = ENTER_ANIMS.find((item) => item.id === id)
      return entry ? entry.outMs : 220
    }

    const BUILTIN_IDS = THEMES.map((theme) => theme.id)

    // Third-party themes without touching this file: a JSON array in localStorage
    // under 'dsh-download-progress:themes', each entry shaped like
    //   { "id": "solarized", "label": "Solarized", "tokens": { "--ddp-accent": "#b58900" } }
    // Nothing is loaded by default; dropping an entry in makes it appear in the
    // dropdown on the next render. Built-in ids always win, and only --ddp-*
    // colour keys survive validation (never --ddp-rows, which is layout).
    const EXTRA_THEMES_KEY = 'dsh-download-progress:themes'
    const TOKEN_VALUE_RE = /^[#(),.%\-0-9a-z\s/]+$/i

    let extraThemes = null

    function sanitizeTokens(tokens) {
      const out = {}
      if (!tokens || typeof tokens !== 'object') return out
      Object.keys(tokens).forEach((key) => {
        const value = tokens[key]
        if (!/^--ddp-[a-z0-9-]+$/.test(key) || key === '--ddp-rows') return
        if (typeof value !== 'string' || !TOKEN_VALUE_RE.test(value)) return
        out[key] = value
      })
      return out
    }

    function loadExtraThemes() {
      if (extraThemes) return extraThemes
      extraThemes = []
      try {
        const raw = window.localStorage.getItem(EXTRA_THEMES_KEY)
        if (!raw) return extraThemes
        const list = JSON.parse(raw)
        if (!Array.isArray(list)) return extraThemes
        extraThemes = list
          .filter(
            (entry) =>
              entry &&
              typeof entry.id === 'string' &&
              entry.id &&
              BUILTIN_IDS.indexOf(entry.id) < 0 &&
              typeof entry.label === 'string' &&
              entry.label,
          )
          .map((entry) => ({
            id: entry.id,
            label: entry.label,
            tokens: sanitizeTokens(entry.tokens),
          }))
      } catch {
        /* corrupted list: keep the built-ins only */
      }
      return extraThemes
    }

    function allThemes() {
      return THEMES.concat(loadExtraThemes())
    }

    function themeExists(id) {
      return allThemes().some((theme) => theme.id === id)
    }

    /** Tokens for one theme id, or null when the host tokens should be used. */
    function themeTokens(id) {
      const theme = allThemes().find((entry) => entry.id === id)
      if (!theme || !theme.tokens) return null
      return Object.keys(theme.tokens).length ? theme.tokens : null
    }

    let cache = null
    const listeners = new Set()

    function coord(value, fallback) {
      const n = Number(value)
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback
    }

    function normalize(input) {
      const src = input && typeof input === 'object' ? input : {}
      const rows = Math.round(Number(src.maxVisible))
      return {
        enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.enabled,
        showSpeed: typeof src.showSpeed === 'boolean' ? src.showSpeed : DEFAULTS.showSpeed,
        maxVisible:
          Number.isFinite(rows) && rows >= 1 && rows <= 6 ? rows : DEFAULTS.maxVisible,
        order: ORDERS.indexOf(src.order) >= 0 ? src.order : DEFAULTS.order,
        debugMode:
          typeof src.debugMode === 'boolean' ? src.debugMode : DEFAULTS.debugMode,
        theme: themeExists(src.theme) ? src.theme : DEFAULTS.theme,
        enterAnim:
          ENTER_ANIM_IDS.indexOf(src.enterAnim) >= 0 ? src.enterAnim : DEFAULTS.enterAnim,
        x: src.x === null || src.x === undefined ? null : coord(src.x, null),
        y: coord(src.y, DEFAULT_Y),
      }
    }

    function readSettings() {
      if (cache) return cache
      let stored = null
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY)
        if (raw) stored = JSON.parse(raw)
      } catch {
        /* private mode / corrupted value: fall back to defaults */
      }
      cache = normalize(stored)
      return cache
    }

    function writeSettings(patch) {
      cache = normalize(Object.assign({}, readSettings(), patch))
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(cache))
      } catch {
        /* storage unavailable: keep the in-memory value for this page */
      }
      listeners.forEach((fn) => {
        try {
          fn()
        } catch {
          /* one broken subscriber must not starve the others */
        }
      })
      return cache
    }

    function subscribeSettings(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }

    function useSettings() {
      const [value, setValue] = React.useState(readSettings)
      React.useEffect(
        () => subscribeSettings(() => setValue(readSettings())),
        [],
      )
      return value
    }

    /* ---------------- sample data (shown only while peeking) ---------------- */

    // The overlay is hidden by default and only a thin handle is visible. Hovering
    // that handle reveals one card per shape the plugin can render, so the UI can
    // be inspected without starting a real download. Sample data is never
    // persisted and never mixed with real tasks: the moment a real task exists it
    // replaces the samples entirely.
    const FAKE_KINDS = ['download', 'install', 'fetch', 'search', 'pkg']

    const FAKE_TOTAL = 29674910
    const FAKE_RATE = 3.4 * 1024 * 1024
    const FAKE_HOLD_MS = 1200
    const FAKE_LOG = [
      'Progress: resolved 128, reused 120, downloaded 8, added 8',
      'Progress: resolved 214, reused 198, downloaded 16, added 16',
      'Progress: resolved 356, reused 340, downloaded 16, added 16',
      'Packages: +16',
    ]

    function fakeTask(kind, elapsed) {
      const t = Math.max(0, Number(elapsed) || 0)
      const id = 'sample-' + kind

      if (kind === 'download') {
        const cycle = (FAKE_TOTAL / FAKE_RATE) * 1000
        const travelled = ((t % (cycle + FAKE_HOLD_MS)) / cycle) * FAKE_TOTAL
        // A little deterministic wobble so the speed readout looks alive
        // without making the bar jump backwards.
        const speed = FAKE_RATE * (1 + 0.08 * Math.sin(t / 850))
        return {
          id,
          kind: 'download',
          label: 'node-v20.11.0-win-x64.zip',
          log: 'https://registry.npmmirror.com/-/binary/node/v20.11.0/node-v20.11.0-win-x64.zip',
          bytes: Math.min(FAKE_TOTAL, Math.round(travelled)),
          total: FAKE_TOTAL,
          speed: Math.round(speed),
          elapsedMs: t,
        }
      }
      if (kind === 'install') {
        return {
          id,
          kind: 'install',
          phase: t > 6000 ? 'applying' : 'installing',
          log: FAKE_LOG[Math.floor(t / 1200) % FAKE_LOG.length],
          elapsedMs: t,
        }
      }
      if (kind === 'fetch') {
        return {
          id,
          kind: 'fetch',
          log: 'https://nodejs.org/dist/v20.11.0/SHASUMS256.txt',
          elapsedMs: t,
        }
      }
      if (kind === 'search') {
        return {
          id,
          kind: 'search',
          label: '下载进度条 插件开发',
          log: 'advanced_search · 下载进度条 插件开发 DSH cordis',
          elapsedMs: t,
        }
      }
      return {
        id,
        kind: 'pkg',
        log: 'python -m pip install --upgrade dsh-cli',
        elapsedMs: t,
      }
    }

    function useSampleTasks(active, startedAt) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (!active) return undefined
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 500)
        return () => clearInterval(timer)
      }, [active, startedAt])
      if (!active || !startedAt) return []
      return FAKE_KINDS.map((kind) => fakeTask(kind, Math.max(0, now - startedAt)))
    }

    /* ---------------- enter / exit presence ---------------- */

    // Keeps a component mounted long enough to play its exit animation. Real
    // tasks and peeked samples both go through this, so the sample cards move
    // exactly like genuine downloads.
    function usePresence(show, ms) {
      const [visible, setVisible] = React.useState(!!show)
      const [leaving, setLeaving] = React.useState(false)

      React.useEffect(() => {
        if (show) {
          setVisible(true)
          setLeaving(false)
          return undefined
        }
        setLeaving(true)
        const timer = setTimeout(() => {
          setVisible(false)
          setLeaving(false)
        }, ms)
        return () => clearTimeout(timer)
      }, [show, ms])

      return { visible, leaving }
    }

    /* ---------------- helpers ---------------- */

    function stateUrl() {
      try {
        return new URL(ROUTE, window.location.origin).toString()
      } catch {
        return ROUTE
      }
    }

    function fmtBytes(n) {
      const v0 = Number(n)
      if (!Number.isFinite(v0) || v0 <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let v = v0
      let i = 0
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i += 1
      }
      const text = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)
      return text + ' ' + units[i]
    }

    function fmtSpeed(n) {
      const v = Number(n)
      return Number.isFinite(v) && v > 0 ? fmtBytes(v) + '/s' : ''
    }

    function secs(ms) {
      const v = Number(ms)
      return Number.isFinite(v) && v > 0 ? Math.floor(v / 1000) : 0
    }

    /* ---------------- data ---------------- */

    function useTasks(enabled) {
      const [tasks, setTasks] = React.useState([])
      React.useEffect(() => {
        if (!enabled) {
          setTasks([])
          return undefined
        }
        let alive = true
        const tick = () => {
          if (!alive) return
          if (typeof document !== 'undefined' && document.hidden) return
          fetch(stateUrl(), { cache: 'no-store' })
            .then((res) => (res && res.ok ? res.json() : null))
            .then((data) => {
              if (!alive || !data) return
              setTasks(Array.isArray(data.tasks) ? data.tasks : [])
            })
            .catch(() => {
              /* the host route is optional: stay silent when it is absent */
            })
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [enabled])
      return tasks
    }

    /* ---------------- overlay view ---------------- */

    function describe(task, options) {
      const showSpeed = !options || options.showSpeed !== false
      const kind = String(task.kind || '')
      const bytes = Number(task.bytes) || 0
      const total = Number(task.total)
      const speed = Number(task.speed) || 0
      const hasTotal = Number.isFinite(total) && total > 0
      const elapsed = secs(task.elapsedMs)

      if (kind === 'download') {
        const log = String(task.log || '')
        if (task.unresolved) return { name: '载入中...', meta: elapsed + 's', determinate: false, log }
        const size = hasTotal ? fmtBytes(bytes) + ' / ' + fmtBytes(total) : fmtBytes(bytes)
        const sp = showSpeed ? fmtSpeed(speed) : ''
        return {
          name: task.label || '下载中...',
          meta: sp ? size + ' · ' + sp : size,
          determinate: hasTotal,
          log,
        }
      }
      if (kind === 'install') {
        return {
          name: task.phase === 'applying' ? '插件安装中...应用配置中...' : '插件安装中...下载中...',
          meta: elapsed + 's',
          determinate: false,
          log: String(task.log || ''),
        }
      }
      if (kind === 'fetch') {
        return {
          name: '正在抓取网页中...' + elapsed + 's',
          meta: '',
          determinate: false,
          log: String(task.log || ''),
        }
      }
      if (kind === 'search') {
        return {
          name: '正在搜索「' + (task.label || '…') + '」中...请稍后',
          meta: '',
          determinate: false,
          log: String(task.log || ''),
        }
      }
      return {
        name: '载入中...',
        meta: elapsed + 's',
        determinate: false,
        log: String(task.log || ''),
      }
    }

    // Stagger between cards so a stack lights up as a sequence rather than a
    // single flash. Kept short: five cards spend 220ms in total.
    const STAGGER_MS = 55

    function Card(props) {
      const task = props.task || {}
      const view = describe(task, { showSpeed: props.showSpeed })
      const total = Number(task.total)
      const bytes = Number(task.bytes) || 0
      const percent =
        view.determinate && Number.isFinite(total) && total > 0
          ? Math.max(0, Math.min(100, (bytes / total) * 100))
          : null
      const phase = props.phase === 'out' ? 'out' : 'in'
      const delay = phase === 'in' ? Math.max(0, Number(props.index) || 0) * STAGGER_MS : 0

      return h(
        'div',
        {
          className: 'ddp-card ddp-ease-' + props.ease + ' ddp-anim--' + phase,
          style: delay ? { animationDelay: delay + 'ms' } : undefined,
        },
        h(
          'div',
          { className: 'ddp-row' },
          h('span', { className: 'ddp-name', title: view.name }, view.name),
          view.meta ? h('span', { className: 'ddp-meta' }, view.meta) : null,
        ),
        h(
          'div',
          { className: 'ddp-track' },
          h(
            'div',
            { className: 'ddp-clip' },
            h('div', {
              className: percent === null ? 'ddp-fill ddp-fill--indet' : 'ddp-fill',
              style: percent === null ? undefined : { width: percent.toFixed(2) + '%' },
            }),
          ),
          percent === null ? null : h('span', { className: 'ddp-tip' }, percent.toFixed(1) + '%'),
        ),
        view.log ? h('div', { className: 'ddp-log' }, view.log) : null,
      )
    }

    // Drag session lives at module scope: there is exactly one overlay, and the
    // move/up listeners are attached to the window, not to the element.
    let dragSession = null

    function beginDrag(event) {
      if (!event || (event.button !== undefined && event.button !== 0)) return
      const el = event.currentTarget
      if (!el || typeof el.getBoundingClientRect !== 'function') return
      // Always measure the wrapper, never the element that was grabbed. The grip
      // sits 12px below the wrapper's top edge (6px tall + 6px margin) and is only
      // 56px wide, so taking the grip's own rect would make the overlay creep
      // upwards by 12px on every drag and would let the clamp believe the overlay
      // is 56px wide instead of 560px.
      const wrap = (typeof el.closest === 'function' && el.closest('.ddp-wrap')) || el
      if (!wrap || typeof wrap.getBoundingClientRect !== 'function') return
      const rect = wrap.getBoundingClientRect()
      dragSession = {
        el: wrap,
        startX: Number(event.clientX) || 0,
        startY: Number(event.clientY) || 0,
        originX: rect.left,
        originY: rect.top,
        width: rect.width,
        height: rect.height,
        moved: false,
        last: null,
      }
    }

    function clampInto(x, y, width, height) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 768
      const maxX = Math.max(8, vw - width - 8)
      const maxY = Math.max(8, vh - height - 8)
      return {
        x: Math.round(Math.max(8, Math.min(maxX, x))),
        y: Math.round(Math.max(8, Math.min(maxY, y))),
      }
    }

    // Peek session at module scope: a remount keeps the same fake clock, so the
    // sample cards do not restart mid-hover. React state below still drives the
    // re-render; this object only supplies the seed and the start timestamp.
    const peekState = { on: false, at: 0 }

    function setPeek(on) {
      if (on && !peekState.on) peekState.at = Date.now()
      if (!on) peekState.at = 0
      peekState.on = on
    }

    // Hover intent. Even with the hit area bridged, a pointer can clip the edge
    // of the grip for one frame while travelling down; collapsing instantly makes
    // the cards flash. Keep the peek alive for a short grace period and cancel it
    // as soon as the pointer is back over the grip or the cards.
    const LEAVE_GRACE_MS = 180
    let leaveTimer = 0

    function cancelLeave() {
      if (leaveTimer) clearTimeout(leaveTimer)
      leaveTimer = 0
    }

    function scheduleLeave(collapse) {
      cancelLeave()
      leaveTimer = setTimeout(() => {
        leaveTimer = 0
        collapse()
      }, LEAVE_GRACE_MS)
    }

    function Overlay() {
      const settings = useSettings()
      const liveTasks = useTasks(settings.enabled)

      // Peeking = the pointer is on the handle / the expanded list. Only allowed
      // when nothing real is in flight, so samples can never sit next to real rows.
      const [peeking, setPeeking] = React.useState(() => peekState.on)
      const hasReal = liveTasks.length > 0
      // Sample cards exist only as a UI workbench. With debug mode off the overlay
      // shows nothing but real downloads, so a placeholder can never be mistaken
      // for an actual transfer.
      const canPeek = settings.debugMode

      const samples = useSampleTasks(peeking && !hasReal && canPeek, peekState.at)
      const tasks = hasReal ? liveTasks : samples

      // Turning debug mode off must not leave a pending collapse or a stale peek
      // session behind, or the samples would pop back the next time it is enabled.
      // Turning it on reveals the samples immediately: with only the slim grip on
      // screen there is nothing to see, so the toggle would look like a no-op.
      React.useEffect(() => {
        if (!canPeek) {
          cancelLeave()
          setPeek(false)
          setPeeking(false)
          return
        }
        setPeek(true)
        setPeeking(true)
      }, [canPeek])

      const [drag, setDrag] = React.useState(null)

      React.useEffect(() => {
        if (typeof window === 'undefined' || !window.addEventListener) return undefined
        const move = (event) => {
          const session = dragSession
          if (!session) return
          const dx = (Number(event.clientX) || 0) - session.startX
          const dy = (Number(event.clientY) || 0) - session.startY
          if (!session.moved && Math.abs(dx) + Math.abs(dy) < 5) return
          session.moved = true
          // Peeking grows the wrapper (5 sample cards), so re-measure instead of
          // trusting the size captured on pointerdown — otherwise the clamp would
          // use a 12px-tall box while the overlay is 300px tall.
          let width = session.width
          let height = session.height
          if (session.el && typeof session.el.getBoundingClientRect === 'function') {
            const rect = session.el.getBoundingClientRect()
            width = rect.width
            height = rect.height
          }
          session.last = clampInto(session.originX + dx, session.originY + dy, width, height)
          setDrag(session.last)
          if (event.cancelable) event.preventDefault()
        }
        const finish = () => {
          const session = dragSession
          dragSession = null
          if (session && session.moved && session.last) {
            writeSettings({ x: session.last.x, y: session.last.y })
          }
          setDrag(null)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
          // A pending collapse must not fire after the overlay is gone.
          cancelLeave()
          dragSession = null
        }
      }, [])

      // Every hook must run on every render, including the renders that produce
      // nothing. Returning early before usePresence / useState below would change
      // the hook count between renders and React would throw "Rendered fewer hooks
      // than expected" — which kills the overlay permanently, so toggling debug
      // mode off and back on could never bring it back.
      const show = hasReal || (peeking && samples.length > 0)
      const { visible, leaving } = usePresence(show, enterAnimMs(settings.enterAnim))

      // While the exit animation runs the list is already empty, so the last
      // populated frame is what actually animates out.
      const held = React.useState(() => ({ list: [] }))[0]
      if (tasks.length) held.list = tasks
      const shown = tasks.length ? tasks : held.list

      const pos = drag || { x: settings.x, y: settings.y }
      const position = { top: pos.y + 'px' }
      if (pos.x === null || pos.x === undefined) {
        position.left = '50%'
        position.transform = 'translateX(-50%)'
      } else {
        position.left = pos.x + 'px'
        position.transform = 'none'
      }
      // Theme = custom properties on the wrapper. 'auto' contributes nothing, so
      // each rule falls through to the host token it already had.
      const themeStyle = themeTokens(settings.theme)
      if (themeStyle) Object.assign(position, themeStyle)
      // Peeking shows every sample shape at once, so the row cap must not clip it.
      const rows = hasReal
        ? settings.maxVisible
        : Math.max(settings.maxVisible, shown.length || settings.maxVisible)
      position['--ddp-rows'] = String(rows)

      const ordered = settings.order === 'newest-first' ? shown.slice().reverse() : shown

      // Bail out only here: all hooks above have already run, so the hook count
      // stays identical whether or not anything is painted.
      if (!settings.enabled) return null
      // Real downloads always show. Without one, the overlay exists only in debug
      // mode — otherwise it renders nothing at all (not even the grip).
      if (!hasReal && !canPeek) return null

      const enter = (event) => {
        // Nothing to peek at unless debug mode is on; a real download keeps the
        // overlay up on its own.
        if (!canPeek) return
        // Cancel any pending collapse before deciding: coming back onto the grip
        // or the cards always wins over a collapse that was just scheduled.
        cancelLeave()
        const node = event && event.currentTarget
        const from = event && event.relatedTarget
        if (node && typeof node.contains === 'function' && from && node.contains(from)) return
        setPeek(true)
        setPeeking(true)
      }
      const leave = (event) => {
        // A drag owns the overlay until pointerup: collapsing the peek mid-drag
        // would make the cards disappear under the cursor while the pointer is
        // still held down.
        if (dragSession) return
        const node = event && event.currentTarget
        const to = event && event.relatedTarget
        if (node && typeof node.contains === 'function' && to && node.contains(to)) return
        scheduleLeave(() => {
          setPeek(false)
          setPeeking(false)
        })
      }

      const handle = hasReal
        ? null
        : h(
            'div',
            {
              className: 'ddp-handle' + (canPeek ? ' ddp-handle--debug' : ''),
              onPointerDown: beginDrag,
              title: canPeek ? '拖动可调整位置 · 悬停展开示例' : '拖动可调整位置',
            },
            canPeek ? '下载进度条 · 示例预览' : null,
          )

      return h(
        'div',
        {
          className:
            'ddp-wrap' +
            (peeking && !hasReal ? ' ddp-wrap--peek' : '') +
            (drag ? ' ddp-wrap--drag' : ''),
          'aria-live': 'polite',
          style: position,
          onPointerOver: enter,
          onPointerOut: leave,
        },
        handle,
        visible
          ? h(
              'div',
              {
                className: 'ddp-list',
                onPointerDown: beginDrag,
              },
              ordered.map((task, index) =>
                h(Card, {
                  key: task.id || String(index),
                  task,
                  showSpeed: settings.showSpeed,
                  ease: settings.enterAnim,
                  phase: leaving ? 'out' : 'in',
                  index,
                }),
              ),
            )
          : null,
      )
    }

    /* ---------------- settings page view ---------------- */

    function SettingRow(props) {
      return h(
        'div',
        { className: 'ddp-set-row' },
        h(
          'div',
          { className: 'ddp-set-text' },
          h('div', { className: 'ddp-set-label' }, props.label),
          props.hint ? h('div', { className: 'ddp-set-hint' }, props.hint) : null,
        ),
        h('div', { className: 'ddp-set-ctrl' }, props.children),
      )
    }

    function toggleRow(props) {
      return h(
        SettingRow,
        { label: props.label, hint: props.hint },
        h('input', {
          type: 'checkbox',
          className: 'ddp-set-check',
          checked: !!props.checked,
          'aria-label': props.label,
          onChange: (event) => props.onChange(!!(event.target && event.target.checked)),
        }),
      )
    }

    function SettingsPage() {
      const settings = useSettings()
      const set = writeSettings
      const rowCounts = [1, 2, 3, 4, 5, 6]

      return h(
        'div',
        { className: 'ddp-set' },
        toggleRow({
          label: '显示下载进度浮层',
          hint: '关闭后不再轮询状态接口，也不渲染任何浮层。',
          checked: settings.enabled,
          onChange: (next) => set({ enabled: next }),
        }),
        toggleRow({
          label: '显示下载速度',
          hint: '在已下载大小旁边显示当前速度，例如 3.2 MB/s。',
          checked: settings.showSpeed,
          onChange: (next) => set({ showSpeed: next }),
        }),
        toggleRow({
          label: '调试模式（显示模拟数据）',
          hint: '打开后，没有真实下载时浮层会显示一条可拖动的把手；鼠标移到把手上会展开 5 张模拟卡片，用来调 UI。关闭后只显示真实下载，没有任何占位内容。',
          checked: settings.debugMode,
          onChange: (next) => set({ debugMode: next }),
        }),
        h(
          SettingRow,
          {
            label: '新任务的排列位置',
            hint: '同时有多个下载时，最新出现的条目放在列表顶部还是底部。',
          },
          h(
            'select',
            {
              className: 'ddp-set-select',
              value: settings.order,
              'aria-label': '排列顺序',
              onChange: (event) => set({ order: event.target.value }),
            },
            h('option', { value: 'newest-first' }, '最新在前'),
            h('option', { value: 'oldest-first' }, '最新在后'),
          ),
        ),
        h(
          SettingRow,
          {
            label: '主题',
            hint: '「跟随系统」直接沿用 DSH 当前主题；亮色/暗色只作用于浮层。新增主题只需在 client.js 的 THEMES 里加一项，这个下拉会自动出现新选项。',
          },
          h(
            'select',
            {
              className: 'ddp-set-select',
              value: settings.theme,
              'aria-label': '主题',
              onChange: (event) => set({ theme: event.target.value }),
            },
            allThemes().map((theme) =>
              h('option', { key: theme.id, value: theme.id }, theme.label),
            ),
          ),
        ),
        h(
          SettingRow,
          {
            label: '出现动画',
            hint: '浮层出现 / 收起时的动效。「CRT 开关机」是从一条亮线展开、收起时再缩成亮线消失；「无动画」则瞬间出现。',
          },
          h(
            'select',
            {
              className: 'ddp-set-select',
              value: settings.enterAnim,
              'aria-label': '出现动画',
              onChange: (event) => set({ enterAnim: event.target.value }),
            },
            ENTER_ANIMS.map((anim) =>
              h('option', { key: anim.id, value: anim.id }, anim.label),
            ),
          ),
        ),
        h(
          SettingRow,
          { label: '最多同时显示条数', hint: '超出的条目在浮层内滚动查看。' },
          h(
            'select',
            {
              className: 'ddp-set-select',
              value: String(settings.maxVisible),
              'aria-label': '最多同时显示条数',
              onChange: (event) => set({ maxVisible: Number(event.target.value) }),
            },
            rowCounts.map((n) => h('option', { key: String(n), value: String(n) }, String(n) + ' 条')),
          ),
        ),
        h(
          SettingRow,
          {
            label: '浮层位置',
            hint: '有下载时直接拖动卡片即可换位置，松手记住；「重置位置」回到顶部居中。',
          },
          h(
            'button',
            {
              type: 'button',
              className: 'ddp-set-btn',
              onClick: () => set({ x: null, y: DEFAULT_Y }),
            },
            '重置位置',
          ),
        ),
        h(
          'div',
          { className: 'ddp-set-note' },
          '调试模式关闭（默认）时，浮层只显示真实下载；没有下载就完全不显示，不占位、不误导。',
          h('br'),
          '打开调试模式后，没有下载时会出现一条把手，鼠标移到把手上展开 5 种形态的示例卡片（下载 / 安装 / 抓取 / 搜索 / 载入中），用来比对 UI；',
          '一旦有真实下载，示例自动让位，有几个任务就只显示几张卡片。',
          h('br'),
          '能拿到真实进度：curl / wget / Invoke-WebRequest -OutFile / git clone 把文件落盘到本地时——',
          '显示已下载大小、总大小与实时速度，悬停进度条可看百分比。',
          h('br'),
          '拿不到字节数：不落盘的下载、网页抓取、搜索、模型流式输出——',
          '这些显示不确定进度条与已用时。',
        ),
      )
    }

    /* ---------------- plugin ---------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const existing = document.getElementById('dsh-download-progress-style')
          if (existing) existing.remove()
          const style = document.createElement('style')
          style.id = 'dsh-download-progress-style'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            const node = document.getElementById('dsh-download-progress-style')
            if (node) node.remove()
          }
        })

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-download-progress', order: 900 },
            Overlay,
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-download-progress',
              order: 60,
              label: () => '下载进度条',
            },
            SettingsPage,
          ),
        )
      },
    }
  },
})
