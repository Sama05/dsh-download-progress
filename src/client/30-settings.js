    /* ---------------- settings store (localStorage) ---------------- */

    const SETTINGS_KEY = 'dsh-download-progress:settings'
    const ORDERS = ['newest-first', 'oldest-first']
    // Two presenters, one dataset. 'overlay' is the floating card stack (what the
    // plugin has always done); 'inline' is the compact bar inside the composer
    // tool row; 'both' is allowed because they cost nothing to run together and
    // someone may want the glance plus the details.
    const DISPLAYS = ['overlay', 'inline', 'both']
    const DISPLAY_LABELS = [
      { value: 'overlay', label: '浮层（悬浮卡片）' },
      { value: 'inline', label: '对话框简易条' },
      { value: 'both', label: '两者都显示' },
    ]
    const DEFAULT_Y = 76
    const DEFAULTS = {
      enabled: true,
      // Default keeps the historical single presenter, so upgrading changes
      // nothing on screen until the user picks the simple bar.
      display: 'overlay',
      showSpeed: true,
      maxVisible: 3,
      order: 'newest-first',
      // Off = the stacked list every session reports into, which is what the
      // overlay did before session blocks existed. On = only the session the
      // main view is showing, so switching sessions switches the progress too.
      currentOnly: false,
      // Off by default: sample cards must never be mistaken for a real download.
      debugMode: false,
      theme: 'auto',
      enterAnim: 'float',
      // null x means "horizontally centred"; a number is a percentage of the
      // viewport width, written by dragging, so a later window resize keeps the
      // card at the same relative spot instead of stranding it.
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
        '--ddp-fg-dim': '#494951',
        // Frosted glass wants a light tint, not an opaque plate: the blur behind
        // it supplies the rest of the material. Held low on purpose — at .66 this
        // read as a white card with a blurry feel, not as glass over the page.
        '--ddp-card-bg': 'rgba(255,255,255,.26)',
        '--ddp-card-border': 'rgba(0,0,0,.10)',
        '--ddp-track-bg': 'rgba(0,0,0,.10)',
        '--ddp-pop-bg': '#ffffff',
        '--ddp-pop-border': 'rgba(0,0,0,.14)',
        '--ddp-inner-hi': 'rgba(255,255,255,.55)',
        // No brightness lift in light mode: it pushed the pane toward paper white.
        '--ddp-glass': 'blur(24px) saturate(180%)',
        '--ddp-sheen': 'rgba(255,255,255,.14)',
        '--ddp-ripple': 'rgba(90,140,255,.24)',
        '--ddp-chip-bg': 'rgba(0,0,0,.06)',
        '--ddp-chip-border': 'rgba(0,0,0,.14)',
        // Light plate: near-white glass so the dark header text keeps contrast,
        // and no halo — a dark shadow under dark text on white just smears.
        '--ddp-group-bg': 'rgba(255,255,255,.55)',
        '--ddp-group-border': 'rgba(0,0,0,.10)',
        '--ddp-group-shadow': 'none',
        // Inline bar: the composer tool row is already a light material, so the
        // chip needs a touch of dark to separate from it, not more white.
        '--ddp-mx-bg': 'rgba(0,0,0,.05)',
        '--ddp-mx-border': 'rgba(0,0,0,.12)',
        '--ddp-mx-bg-hover': 'rgba(0,0,0,.09)',
        '--ddp-mx-border-hover': 'rgba(0,0,0,.22)',
      },
      dark: {
        '--ddp-accent': '#4c8dff',
        '--ddp-grip': '#a8a8b0',
        '--ddp-fg': '#e8e8ea',
        '--ddp-fg-dim': '#a8a8b0',
        '--ddp-card-bg': 'rgba(28,28,32,.40)',
        '--ddp-card-border': 'rgba(255,255,255,.12)',
        '--ddp-track-bg': 'rgba(255,255,255,.13)',
        '--ddp-pop-bg': '#2a2a30',
        '--ddp-pop-border': 'rgba(255,255,255,.14)',
        '--ddp-inner-hi': 'rgba(255,255,255,.13)',
        '--ddp-glass': 'blur(24px) saturate(180%) brightness(1.06)',
        '--ddp-sheen': 'rgba(255,255,255,.08)',
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
      { id: 'slide', label: '横向滑入', outMs: 220 },
      { id: 'drop', label: '下落弹入', outMs: 200 },
      { id: 'pop', label: '弹性放大', outMs: 200 },
      { id: 'wipe', label: '横扫揭示', outMs: 240 },
      { id: 'flip', label: '翻折展开', outMs: 260 },
      { id: 'spin', label: '旋转入位', outMs: 220 },
      { id: 'blur', label: '模糊聚焦', outMs: 240 },
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

    // Layout variables are owned by the overlay, never by a theme: --ddp-rows is
    // the row budget and --ddp-heads is the height the session headers add. A
    // theme that could set either one would break the list's height maths.
    const LAYOUT_TOKENS = ['--ddp-rows', '--ddp-heads']

    function sanitizeTokens(tokens) {
      const out = {}
      if (!tokens || typeof tokens !== 'object') return out
      Object.keys(tokens).forEach((key) => {
        const value = tokens[key]
        if (!/^--ddp-[a-z0-9-]+$/.test(key) || LAYOUT_TOKENS.indexOf(key) >= 0) return
        if (typeof value !== 'string' || !TOKEN_VALUE_RE.test(value)) return
        out[key] = value
      })
      return out
    }

    function loadExtraThemes() {
      if (extraThemes) return extraThemes
      const list = readJSON(EXTRA_THEMES_KEY, null)
      extraThemes = !Array.isArray(list)
        ? []
        : list
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

    /**
     * Horizontal position, stored as a percentage of the viewport width.
     *
     * A pixel offset would be frozen at the window size it was dragged in, so
     * resizing the DSH window would leave the overlay stranded off-centre. A
     * percentage is resolved by the browser on every layout, which keeps the
     * card at the same relative spot and costs nothing at runtime.
     *
     * `null` means "centred". Anything outside 0..100 is rejected — that also
     * migrates values written by older versions, which stored raw pixels.
     */
    function percent(value) {
      if (value === null || value === undefined) return null
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0 || n > 100) return null
      return Math.round(n * 100) / 100
    }

    function normalize(input) {
      const src = input && typeof input === 'object' ? input : {}
      const rows = Math.round(Number(src.maxVisible))
      return {
        enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.enabled,
        display: DISPLAYS.indexOf(src.display) >= 0 ? src.display : DEFAULTS.display,
        showSpeed: typeof src.showSpeed === 'boolean' ? src.showSpeed : DEFAULTS.showSpeed,
        maxVisible:
          Number.isFinite(rows) && rows >= 1 && rows <= 6 ? rows : DEFAULTS.maxVisible,
        order: ORDERS.indexOf(src.order) >= 0 ? src.order : DEFAULTS.order,
        currentOnly:
          typeof src.currentOnly === 'boolean' ? src.currentOnly : DEFAULTS.currentOnly,
        debugMode:
          typeof src.debugMode === 'boolean' ? src.debugMode : DEFAULTS.debugMode,
        theme: themeExists(src.theme) ? src.theme : DEFAULTS.theme,
        enterAnim:
          ENTER_ANIM_IDS.indexOf(src.enterAnim) >= 0 ? src.enterAnim : DEFAULTS.enterAnim,
        x: percent(src.x),
        y: coord(src.y, DEFAULT_Y),
      }
    }

    function readSettings() {
      if (cache) return cache
      cache = normalize(readJSON(SETTINGS_KEY, null))
      return cache
    }

    function writeSettings(patch) {
      cache = normalize(Object.assign({}, readSettings(), patch))
      writeJSON(SETTINGS_KEY, cache)
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

