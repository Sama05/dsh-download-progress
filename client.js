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
    /**
     * Consecutive failed polls before the last frame is dropped.
     *
     * A host that is restarting (or a route that briefly 502s) should not blank the
     * overlay — the download is still running. A host that has been gone for five
     * seconds is not coming back in this second, and a frozen bar that never moves
     * again is worse than no bar.
     */
    const POLL_FAILURES_BEFORE_CLEAR = 5

    /* ---------------- styles (the one place UI is defined) ---------------- */

    const CSS = `
/* ---- floating overlay ---- */
.ddp-wrap{
  --ddp-rows:3;
  /* Height the session headers add; the overlay overwrites it once it knows how
     many blocks it will draw. 0 keeps the single-session layout unchanged. */
  --ddp-heads:0px;
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
     the requested rows instead of clipping the last card's tail. The vh term is
     a ceiling for short windows — without it a 6-row budget overflows the viewport
     once the overlay is dragged near an edge. */
  max-height:min(
    calc(var(--ddp-rows) * 62px + (var(--ddp-rows) - 1) * 8px + 6px + var(--ddp-heads, 0px)),
    calc(100vh - 48px)
  );
  overflow-y:auto;overflow-x:hidden;
  /* A little air on all sides: the cards are separated by their own border now,
     so they must not sit flush against the scroll viewport edge. */
  padding:4px;
  /* No scrollbar, by design. A classic scrollbar takes layout width, so crossing
     the row cap would narrow every card by 6px and re-wrap the log line mid-poll
     — a quiet jitter that looks like a rendering bug. The list still scrolls by
     wheel / trackpad; only the track is hidden. */
  scrollbar-width:none;-ms-overflow-style:none;
  cursor:grab;
}
.ddp-list:active{cursor:grabbing}
/* While dragging, text selection and hover tips would fight the gesture. */
.ddp-wrap--drag .ddp-list{cursor:grabbing;user-select:none}
.ddp-wrap--drag .ddp-tip{opacity:0 !important}
.ddp-list::-webkit-scrollbar{width:0;height:0}
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

/* ---- six more feels, same one-class-per-card shape ------------------------
   They stick to transform / clip-path on purpose. A filter on the card makes
   it a new backdrop root, so the glass loses its blur for as long as the
   animation runs (the CRT feel has always paid that price). Blur is the one
   that spends it deliberately; everything else here keeps the pane intact. */

/* Slide: enters from the left edge, leaves to the right — the only feel with a
   directional bias, which is why its exit does not mirror its entry. */
.ddp-anim--in.ddp-ease-slide{animation:ddp-slide-in .3s cubic-bezier(.2,.85,.25,1) backwards}
.ddp-anim--out.ddp-ease-slide{animation:ddp-slide-out .22s ease-in forwards}
@keyframes ddp-slide-in{
  from{opacity:0;transform:translateX(-16px)}
  to{opacity:1;transform:translateX(0)}
}
@keyframes ddp-slide-out{
  from{opacity:1;transform:translateX(0)}
  to{opacity:0;transform:translateX(14px)}
}

/* Drop: falls in from above. The bounce lives in the timing function rather than
   the keyframes, so the card never overshoots its own top edge mid-flight. */
.ddp-anim--in.ddp-ease-drop{animation:ddp-drop-in .34s cubic-bezier(.34,1.42,.5,1) backwards}
.ddp-anim--out.ddp-ease-drop{animation:ddp-drop-out .2s ease-in forwards}
@keyframes ddp-drop-in{
  from{opacity:0;transform:translateY(-14px) scale(.99)}
  to{opacity:1;transform:translateY(0) scale(1)}
}
@keyframes ddp-drop-out{
  from{opacity:1;transform:translateY(0)}
  to{opacity:0;transform:translateY(-10px)}
}

/* Pop: springs up from a shrunken state with a visible overshoot. */
.ddp-anim--in.ddp-ease-pop{animation:ddp-pop-in .32s cubic-bezier(.2,1.5,.4,1) backwards}
.ddp-anim--out.ddp-ease-pop{animation:ddp-pop-out .2s ease-in forwards}
@keyframes ddp-pop-in{
  from{opacity:0;transform:scale(.86)}
  to{opacity:1;transform:scale(1)}
}
@keyframes ddp-pop-out{
  from{opacity:1;transform:scale(1)}
  to{opacity:0;transform:scale(.9)}
}

/* Wipe: a hard edge sweeps across and leaves the card in place — no fade, so the
   first frame already reads as "this is arriving". The rounded corner still
   clips it because the card itself is overflow:hidden. */
.ddp-anim--in.ddp-ease-wipe{animation:ddp-wipe-in .34s cubic-bezier(.3,.9,.3,1) backwards}
.ddp-anim--out.ddp-ease-wipe{animation:ddp-wipe-out .24s ease-in forwards}
@keyframes ddp-wipe-in{
  from{clip-path:inset(0 100% 0 0)}
  to{clip-path:inset(0 0 0 0)}
}
@keyframes ddp-wipe-out{
  from{clip-path:inset(0 0 0 0)}
  to{clip-path:inset(0 0 0 100%)}
}

/* Flip: swings down from a tilted plane. perspective() sits inside the
   transform so the origin stays at the card's own centre with no wrapper. */
.ddp-anim--in.ddp-ease-flip{animation:ddp-flip-in .4s cubic-bezier(.25,.9,.3,1) backwards}
.ddp-anim--out.ddp-ease-flip{animation:ddp-flip-out .26s ease-in forwards}
@keyframes ddp-flip-in{
  from{opacity:0;transform:perspective(620px) rotateX(-74deg)}
  60%{opacity:1;transform:perspective(620px) rotateX(6deg)}
  to{opacity:1;transform:perspective(620px) rotateX(0)}
}
@keyframes ddp-flip-out{
  from{opacity:1;transform:perspective(620px) rotateX(0)}
  to{opacity:0;transform:perspective(620px) rotateX(58deg)}
}

/* Spin: a short helical entry — the card rotates and scales at once, so it reads
   as screwing into place rather than as a plain zoom. */
.ddp-anim--in.ddp-ease-spin{animation:ddp-spin-in .36s cubic-bezier(.22,1.2,.34,1) backwards}
.ddp-anim--out.ddp-ease-spin{animation:ddp-spin-out .22s ease-in forwards}
@keyframes ddp-spin-in{
  from{opacity:0;transform:rotate(-8deg) scale(.9)}
  to{opacity:1;transform:rotate(0) scale(1)}
}
@keyframes ddp-spin-out{
  from{opacity:1;transform:rotate(0) scale(1)}
  to{opacity:0;transform:rotate(5deg) scale(.94)}
}

/* Blur: resolves out of a frosted haze. This is the feel that knowingly spends
   the backdrop root — a wide blur radius animating is exactly what reads as
   focus pulling, and the glass coming back into focus at the end is the point. */
.ddp-anim--in.ddp-ease-blur{animation:ddp-blur-in .38s ease-out backwards}
.ddp-anim--out.ddp-ease-blur{animation:ddp-blur-out .24s ease-in forwards}
@keyframes ddp-blur-in{
  from{opacity:0;filter:blur(9px);transform:scale(1.02)}
  to{opacity:1;filter:blur(0);transform:scale(1)}
}
@keyframes ddp-blur-out{
  from{opacity:1;filter:blur(0)}
  to{opacity:0;filter:blur(7px)}
}
/* Frosted glass, iOS/macOS style: the blur is what makes the card read as a
   pane of glass, so the card itself is only a light translucent tint over
   whatever sits behind it. There is deliberately no specular corner bloom —
   real glass shows a hairline of light along its top edge, nothing more. */
.ddp-card{
  /* The list is a flex column with a max-height, so cards MUST opt out of
     shrinking. Without this they compress into hairlines instead of the list
     scrolling: overflow:hidden on the card zeroes its automatic minimum size,
     which is exactly what lets flex squash it past its content. */
  flex:0 0 auto;
  position:relative;isolation:isolate;overflow:hidden;
  background:var(--ddp-card-bg,var(--dsw-alias-bg-overlay,rgba(32,32,36,.9)));
  /* With no theme override, tint the host colour down so the blur has something
     to show. Themes hand over an already-translucent value, so they win as-is. */
  background:var(--ddp-card-bg,color-mix(in srgb,var(--dsw-alias-bg-overlay,rgba(32,32,36,.9)) 62%,transparent));
  border:1px solid var(--ddp-card-border,var(--dsw-alias-border-l1,rgba(255,255,255,.10)));
  border-radius:12px;padding:8px 10px;
  /* No outer drop shadow, by design: the list is a scroll container whose
     overflow clips descendants, so a cast shadow would be sliced into a hard
     rectangle at its padding-box — a faint panel behind the stack. Glass
     separates by blur and border, never by a shadow it cannot show. */
  box-shadow:
    inset 0 -1px 0 var(--ddp-card-border,rgba(255,255,255,.10)),
    inset 0 1px 0 var(--ddp-inner-hi,rgba(255,255,255,.12));
  font-size:12px;line-height:1.45;
  color:var(--ddp-fg,var(--dsw-alias-label-primary,#e8e8ea));
  /* One variable so a theme can retune the whole material (radius, saturation,
     brightness lift) without touching this rule. */
  -webkit-backdrop-filter:var(--ddp-glass,blur(26px) saturate(185%));
  backdrop-filter:var(--ddp-glass,blur(26px) saturate(185%));
  transition:box-shadow .18s ease,transform .18s ease;
}
/* While the window edge is being dragged the cards would re-blur a large
   backdrop every frame, which is the expensive half of a live resize. The blur
   returns on its own a moment after the gesture stops; nothing else changes. */
.ddp-wrap--resizing .ddp-card{
  -webkit-backdrop-filter:none;
  backdrop-filter:none;
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
/* Hover only lifts. It must not change the shading: the shadow is inset now, so
   re-stating it here would be a no-op that implies an outer glow exists. */
.ddp-card:hover{transform:translateY(-1px)}
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
  /* .55 looked right over an opaque plate; once the card became real glass the
     line sat on whatever was behind it and stopped being readable. */
  opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}

/* Sessions. With downloads from more than one session the list groups them:
   each group is a glass block carrying the session name, and the task cards
   live inside it. With a single session nothing is wrapped, so the plain
   one-session overlay keeps exactly the look it had before grouping existed. */
.ddp-group{
  flex:0 0 auto;display:flex;flex-direction:column;gap:8px;
  padding:6px 6px 8px;border-radius:14px;
  /* A group is a plate, not a wash. At the old 4.5% tint the chat text behind
     the overlay showed straight through the header row, so a session name that
     already carried the primary foreground still read as doubled and faint —
     the colour was fine, the backdrop was not. Same recipe as a card: the host
     overlay colour cut with transparency, plus blur underneath, so the name has
     something quiet to sit on. */
  background:var(--ddp-group-bg,color-mix(in srgb,var(--dsw-alias-bg-overlay,rgba(32,32,36,.9)) 55%,transparent));
  border:1px solid var(--ddp-group-border,rgba(255,255,255,.09));
  -webkit-backdrop-filter:var(--ddp-group-glass,blur(16px) saturate(170%));
  backdrop-filter:var(--ddp-group-glass,blur(16px) saturate(170%));
}
.ddp-group-head{
  display:flex;align-items:baseline;gap:8px;
  padding:0 2px;font-size:11.5px;line-height:1.4;
  /* The session name is the whole point of a block, so it carries the PRIMARY
     foreground, not the dim one. On the glass material the dim token sat at
     roughly half contrast and the header was reported as too faint to read.
     --ddp-group-fg sits in front so a theme can tune the header on its own
     without touching any other text. */
  color:var(--ddp-group-fg,var(--ddp-fg,var(--dsw-alias-label-primary,#e8e8ea)));
  /* A 1px dark halo under the name. Blur alone cannot fully separate 11px text
     from whatever chat line happens to sit behind the overlay; the halo buys the
     contrast back without brightening the plate. Themes set --ddp-group-shadow
     to 'none' where a halo would smear (the light plate). */
  text-shadow:var(--ddp-group-shadow,0 1px 2px rgba(0,0,0,.5));
}
.ddp-group-name{
  flex:1 1 auto;min-width:0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  font-weight:600;
}
/* A session with several calls in flight: the count is the only cue that the
   block holds more than the one card the header sits above. */
.ddp-group-count{flex:0 0 auto;opacity:.75;font-variant-numeric:tabular-nums}
.ddp-group-cards{display:flex;flex-direction:column;gap:8px}

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

    /* ================================================================== */
    /* Shared utilities                                                     */
    /*                                                                      */
    /* The host serves the client half as ONE bundle, so unlike the Host    */
    /* half this file cannot import from a sibling module. Everything that  */
    /* is used in more than one place therefore lives in this block, and    */
    /* every call site below goes through it instead of re-deriving the     */
    /* same values in its own little copy.                                  */
    /* ================================================================== */

    /** Join class names, dropping falsy entries: `cx('a', cond && 'b')`. */
    function cx() {
      return Array.prototype.filter.call(arguments, Boolean).join(' ')
    }

    /** Clamp a number into [lo, hi]. */
    function clamp(n, lo, hi) {
      return Math.max(lo, Math.min(hi, n))
    }

    /** Read and parse a localStorage key; any failure yields the fallback. */
    function readJSON(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        return raw ? JSON.parse(raw) : fallback
      } catch {
        /* private mode, corrupted value, or storage disabled */
        return fallback
      }
    }

    /** Persist a value. A full or blocked storage must not break the UI. */
    function writeJSON(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* keep the in-memory value for this page */
      }
    }

    const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

    /**
     * Human-readable size: `1234567` → `1.18 MB`.
     * Precision drops as the number grows (0 / 1 / 2 decimals) so the readout
     * never jitters between `9.99 MB` and `10.0 MB` on every poll.
     */
    function fmtBytes(n) {
      const value = Number(n)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      let size = value
      let unit = 0
      while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
        size /= 1024
        unit += 1
      }
      const text =
        unit === 0 ? String(Math.round(size)) : size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)
      return text + ' ' + BYTE_UNITS[unit]
    }

    /** Bytes per second, or '' when there is no rate worth showing. */
    function fmtSpeed(n) {
      const value = Number(n)
      return Number.isFinite(value) && value > 0 ? fmtBytes(value) + '/s' : ''
    }

    /** Milliseconds → whole seconds, floored at 0. */
    function secs(ms) {
      const value = Number(ms)
      return Number.isFinite(value) && value > 0 ? Math.floor(value / 1000) : 0
    }

    /** The single line of context printed under every bar. */
    function logOf(task) {
      return String(task.log || '')
    }

    /* ---------------- settings store (localStorage) ---------------- */

    const SETTINGS_KEY = 'dsh-download-progress:settings'
    const ORDERS = ['newest-first', 'oldest-first']
    const DEFAULT_Y = 76
    const DEFAULTS = {
      enabled: true,
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

    /* ---------------- sample data (shown only while peeking) ---------------- */

    // The overlay is hidden by default and only a thin handle is visible. Hovering
    // that handle reveals one card per shape the plugin can render, so the UI can
    // be inspected without starting a real download. Sample data is never
    // persisted and never mixed with real tasks: the moment a real task exists it
    // replaces the samples entirely.
    const FAKE_KINDS = ['download', 'install', 'fetch', 'search', 'pkg']

    /** Sample cards tick slower than real data: it is a still image, not a poll. */
    const SAMPLE_TICK_MS = 1000

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
        const timer = setInterval(() => setNow(Date.now()), SAMPLE_TICK_MS)
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

    /* ---------------- data ---------------- */

    /** Absolute URL of the host snapshot route, robust to a missing location. */
    function stateUrl() {
      try {
        return new URL(ROUTE, window.location.origin).toString()
      } catch {
        return ROUTE
      }
    }

    function useTasks(enabled) {
      const [tasks, setTasks] = React.useState([])
      React.useEffect(() => {
        if (!enabled) {
          setTasks([])
          return undefined
        }
        let alive = true
        let failures = 0
        const tick = () => {
          if (!alive) return
          if (typeof document !== 'undefined' && document.hidden) return
          fetch(stateUrl(), { cache: 'no-store' })
            .then((res) => (res && res.ok ? res.json() : null))
            .then((data) => {
              if (!alive) return
              if (!data) {
                // Missing/!ok response: keep the last frame through a short blip,
                // drop it once the host is clearly gone.
                if (++failures >= POLL_FAILURES_BEFORE_CLEAR) setTasks([])
                return
              }
              failures = 0
              setTasks(Array.isArray(data.tasks) ? data.tasks : [])
            })
            .catch(() => {
              /* the host route is optional: stay silent when it is absent */
              if (alive && ++failures >= POLL_FAILURES_BEFORE_CLEAR) setTasks([])
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

    /**
     * Per-kind headline + meta builders.
     *
     * Before this table each shape was another `if` block repeating the same
     * `log: String(task.log || '')` and the same `elapsed + 's'`; adding a shape
     * meant touching four places. Now a shape is one entry, and anything a
     * builder does not return falls back to the shared values below.
     */
    const VIEWS = {
      /** Real bytes: size, optional total, optional rate. */
      download(task, ctx) {
        if (task.unresolved) return { name: '载入中...', meta: ctx.elapsed + 's' }
        const size = ctx.hasTotal
          ? fmtBytes(ctx.bytes) + ' / ' + fmtBytes(ctx.total)
          : fmtBytes(ctx.bytes)
        const speed = ctx.showSpeed ? fmtSpeed(ctx.speed) : ''
        return {
          name: task.label || '下载中...',
          meta: speed ? size + ' · ' + speed : size,
        }
      },
      /** No byte stream at all: phase text plus elapsed time, newest log line. */
      install(task, ctx) {
        return {
          name:
            task.phase === 'applying' ? '插件安装中...应用配置中...' : '插件安装中...下载中...',
          meta: ctx.elapsed + 's',
        }
      },
      /** A single page fetch: only a clock, because nothing is measurable. */
      fetch(task, ctx) {
        return { name: '正在抓取网页中...' + ctx.elapsed + 's', meta: '' }
      },
      /** A search: the query is the only useful thing to show. */
      search(task) {
        return { name: '正在搜索「' + (task.label || '…') + '」中...请稍后', meta: '' }
      },
    }

    /** Unknown shape: still show a card, just without a claim about progress. */
    function fallbackView(task, ctx) {
      return { name: '载入中...', meta: ctx.elapsed + 's' }
    }

    /**
     * Flatten one wire task into everything a card needs.
     *
     * Numbers are coerced once, here, so `Card` never re-parses `task.bytes` /
     * `task.total` and never risks computing a different percentage than the size
     * readout next to it.
     *
     * @param {object} task
     * @param {{showSpeed?: boolean}} [options]
     */
    function describe(task, options) {
      const ctx = {
        showSpeed: !options || options.showSpeed !== false,
        bytes: Number(task.bytes) || 0,
        total: Number(task.total),
        speed: Number(task.speed) || 0,
        elapsed: secs(task.elapsedMs),
      }
      ctx.hasTotal = Number.isFinite(ctx.total) && ctx.total > 0

      const build = VIEWS[task.kind] || fallbackView
      const { name, meta } = build(task, ctx)
      // Only downloads have a meaningful fraction; everything else stays
      // indeterminate even if the host happened to report a total.
      const percent =
        task.kind === 'download' && ctx.hasTotal
          ? clamp((ctx.bytes / ctx.total) * 100, 0, 100)
          : null

      return {
        name,
        meta,
        percent,
        determinate: percent !== null,
        log: logOf(task),
      }
    }

    // Stagger between cards so a stack lights up as a sequence rather than a
    // single flash. Kept short: five cards spend 220ms in total.
    const STAGGER_MS = 55

    function Card(props) {
      const task = props.task || {}
      const view = describe(task, { showSpeed: props.showSpeed })
      const percent = view.percent
      const phase = props.phase === 'out' ? 'out' : 'in'
      const delay = phase === 'in' ? Math.max(0, Number(props.index) || 0) * STAGGER_MS : 0

      return h(
        'div',
        {
          className: cx('ddp-card', 'ddp-ease-' + props.ease, 'ddp-anim--' + phase),
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

    /* ---------------- per-session grouping ---------------- */

    /**
     * Which session a row belongs to, as a stable grouping key.
     *
     * Tasks from one session share this value and are drawn inside one block.
     * Sample cards have no session at all, so they all land under '' and the
     * overlay renders them as the flat list it has always been — a debug peek
     * must not invent session blocks for data that belongs to no session.
     *
     * @param {object} task
     */
    function sessionKeyOf(task) {
      return String((task && task.sessionId) || '')
    }

    /**
     * The name shown on a session block.
     *
     * The host already resolves the real title and falls back to a short id, so
     * this only has to cope with a row that carries neither (an older host, or a
     * sample). '' means "no session", which keeps the flat one-session layout.
     *
     * @param {object} task
     */
    function sessionNameOf(task) {
      const title = String((task && task.sessionTitle) || '')
      if (title) return title
      const id = String((task && task.sessionId) || '')
      return id ? '会话 ' + id.slice(-8) : ''
    }

    /**
     * Split an already-ordered row list into per-session runs.
     *
     * Deliberately a RUN of consecutive rows, not a dict keyed by session: the
     * user's chosen order (newest-first / oldest-first) then still decides what
     * is on top, and a session that starts a second download later returns to
     * the top with a fresh block instead of silently reordering rows inside a
     * block that is already on screen.
     *
     * @param {object[]} list ordered rows
     * @returns {{key: string, name: string, tasks: object[]}[]}
     */
    function runsOf(list) {
      const runs = []
      for (const task of list) {
        const key = sessionKeyOf(task)
        const last = runs[runs.length - 1]
        if (last && last.key === key) last.tasks.push(task)
        else runs.push({ key, name: sessionNameOf(task), tasks: [task] })
      }
      return runs
    }

    /* ---------------- current-session scope ---------------- */

    /**
     * The session the main view is showing right now, or '' when no session
     * occupies it.
     *
     * The centre column renders the session whose `retainedBy.mainView` is set;
     * that is the same projection the shipped title/sidebar code reads, so this
     * follows the user's session switch without any host change. A right-hand
     * panel (file browser, terminal…) owns the main key instead, and in that
     * position no session is "current" — returning '' there makes the overlay
     * fall back to the full list rather than go blank.
     *
     * @param {object} state `useSessions` snapshot
     * @returns {string}
     */
    function mainSessionIdOf(state) {
      const byId = (state && state.byId) || {}
      for (const id of Object.keys(byId)) {
        const row = byId[id]
        if (!row) continue
        const held = row.retainedBy && (row.retainedBy.mainView ?? 0) > 0
        if (held) return String(row.id || id)
      }
      return ''
    }

    /** Selector form, so the overlay only re-renders when the session changes. */
    function selectMainSessionId(state) {
      return mainSessionIdOf(state)
    }

    /** Stand-in when the slot hands no session hook over (offline smoke test). */
    function noSessions() {
      return ''
    }

    /**
     * Drop every row that belongs to another session.
     *
     * Only applied when the user asked for the current session AND that session
     * is actually known: a blank scope keeps the full list, because hiding every
     * download with no way to see why would look like the plugin broke. Rows
     * without a session id (an older host) are kept for the same reason — they
     * cannot be attributed, so they are never the reason something disappears.
     *
     * @param {object[]} list
     * @param {string} sessionId
     * @returns {object[]}
     */
    function scopeToSession(list, sessionId) {
      if (!sessionId) return list
      return list.filter((task) => {
        const own = sessionKeyOf(task)
        return !own || own === sessionId
      })
    }

    /** One session block: a name header plus that session's cards. */
    function Group(props) {
      const run = props.run
      return h(
        'div',
        { className: 'ddp-group' },
        h(
          'div',
          { className: 'ddp-group-head' },
          // The title gets the whole width; hovering a truncated one reveals it.
          h('span', { className: 'ddp-group-name', title: run.name }, run.name),
          run.tasks.length > 1
            ? h('span', { className: 'ddp-group-count' }, run.tasks.length + ' 项')
            : null,
        ),
        h(
          'div',
          { className: 'ddp-group-cards' },
          run.tasks.map((task, index) =>
            h(Card, {
              key: task.id || String(index),
              task,
              showSpeed: props.showSpeed,
              ease: props.ease,
              phase: props.phase,
              // The stagger is per session block, so two sessions that start at
              // once do not double each other's delay into a 400ms wait.
              index,
            }),
          ),
        ),
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
      // Keep at least 8px of the overlay on screen on every edge, so it can never
      // be dragged out of reach.
      const maxX = Math.max(8, vw - width - 8)
      const maxY = Math.max(8, vh - height - 8)
      const left = clamp(x, 8, maxX)
      const top = clamp(y, 8, maxY)
      return {
        x: Math.round(left),
        y: Math.round(top),
        // Half the width, so the drag renderer can place the CENTRE in pixels and
        // keep `translateX(-50%)` on the wrapper the whole time. Switching the
        // transform on drop (none → -50%) would shift the wrapper by half a card
        // for one transition while `left` slid the other way — the visible "jump
        // left, then snap back" after releasing the mouse.
        half: width / 2,
        // Where the card's CENTRE sits, as a percentage of the viewport. This is
        // what gets persisted: the renderer resolves it against the live window
        // size, so resizing keeps the relative position with no JS involved.
        pct: Math.round(((left + width / 2) / vw) * 10000) / 100,
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

    // While the window is being resized the cards would re-blur a large backdrop
    // on every frame. Dropping the filter for the duration of the gesture (and a
    // short tail after it) keeps a live resize responsive; the blur comes back
    // once the pointer stops moving the window edge.
    const RESIZE_IDLE_MS = 200
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

    function Overlay(props) {
      const settings = useSettings()
      const liveTasks = useTasks(settings.enabled)

      // The session the centre column is showing. Called unconditionally and
      // from a stable prop, so the hook order never changes between renders —
      // a conditional hook here would kill the overlay permanently.
      const useSessions = (props && props.useSessions) || noSessions
      const currentSessionId = useSessions(selectMainSessionId)

      // "Current session only" is a display filter, applied before anything
      // else looks at the rows, so the grouping / height / row-cap logic below
      // sees exactly what will be painted and needs no second code path.
      const scoped = settings.currentOnly
        ? scopeToSession(liveTasks, currentSessionId)
        : liveTasks

      // Peeking = the pointer is on the handle / the expanded list. Only allowed
      // when nothing real is in flight, so samples can never sit next to real rows.
      const [peeking, setPeeking] = React.useState(() => peekState.on)
      // Only a well-formed row counts as a real download. An array of nulls must
      // not suppress the sample cards and then paint an empty overlay.
      const realTasks = (Array.isArray(scoped) ? scoped : []).filter(
        (task) => task && typeof task === 'object',
      )
      const hasReal = realTasks.length > 0
      // A download in ANOTHER session still counts for one thing only: it keeps
      // the sample workbench off. Otherwise scoping to a quiet session would
      // summon five fake cards while a real transfer runs next door.
      const hasAnyReal = liveTasks.some((task) => task && typeof task === 'object')
      // Sample cards exist only as a UI workbench. With debug mode off the overlay
      // shows nothing but real downloads, so a placeholder can never be mistaken
      // for an actual transfer.
      const canPeek = settings.debugMode

      const samples = useSampleTasks(peeking && !hasAnyReal && canPeek, peekState.at)
      const tasks = hasReal ? realTasks : samples

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
      // Needed on resize: the clamp limit depends on how wide the card actually
      // is, which only the DOM knows.
      const wrapRef = React.useRef(null)
      const [resizing, setResizing] = React.useState(false)

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
            // Persist the centre as a percentage: the drop position is a pixel
            // offset, but only the ratio survives a window resize.
            writeSettings({ x: session.last.pct, y: session.last.y })
          }
          setDrag(null)
        }

        // A live window resize does two things that matter here: every card
        // re-blurs a large backdrop per frame (expensive), and a card dragged
        // toward an edge can end up half outside a narrower window. One
        // rAF-throttled handler deals with both.
        let raf = 0
        let idleTimer = 0
        const applyResize = () => {
          raf = 0
          setResizing(true)
          const stored = readSettings().x
          if (stored === null) return
          const el = wrapRef.current
          if (!el || typeof el.getBoundingClientRect !== 'function') return
          const width = el.getBoundingClientRect().width
          const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
          // The card still fits while its centre stays half a card plus the
          // 8px edge padding away from both sides.
          const margin = ((width / 2 + 8) / vw) * 100
          const low = Math.min(margin, 50)
          const high = Math.max(100 - margin, 50)
          const next = Math.round(Math.min(high, Math.max(low, stored)) * 100) / 100
          if (Math.abs(next - stored) >= 0.5) writeSettings({ x: next })
        }
        const onResize = () => {
          if (!raf) {
            raf = window.requestAnimationFrame
              ? window.requestAnimationFrame(applyResize)
              : (applyResize(), 0)
          }
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            idleTimer = 0
            setResizing(false)
          }, RESIZE_IDLE_MS)
        }

        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
        window.addEventListener('resize', onResize)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
          window.removeEventListener('resize', onResize)
          if (raf && window.cancelAnimationFrame) window.cancelAnimationFrame(raf)
          if (idleTimer) clearTimeout(idleTimer)
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
      // The route body is JSON from another process. A null or non-object entry
      // must be dropped here: `Card` and the React key both read `task.id`, and a
      // throw inside a slot unmounts the entire overlay — one bad row would take
      // the whole thing down instead of costing one card.
      const safeTasks = (Array.isArray(tasks) ? tasks : []).filter(
        (task) => task && typeof task === 'object',
      )
      if (safeTasks.length) held.list = safeTasks
      const shown = safeTasks.length ? safeTasks : held.list

      // Horizontal placement. The wrapper is ALWAYS centred with
      // `translateX(-50%)`, and `left` always names the card's centre — pixels
      // while dragging, a percentage once dropped. Keeping the transform
      // constant matters: `left` is on a 180ms transition, the transform is not.
      // Flipping the transform at the drop instant (none ⇄ translateX(-50%))
      // while `left` was still easing to its new value shifted the card half a
      // width instantly and then slid it back — the "jumps left, then snaps
      // back" flicker seen right after releasing the mouse.
      const position = { top: (drag ? drag.y : settings.y) + 'px' }
      position.transform = 'translateX(-50%)'
      if (drag) {
        position.left = drag.x + drag.half + 'px'
      } else if (settings.x === null) {
        position.left = '50%'
      } else {
        position.left = settings.x + '%'
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

      // Session blocks. One session keeps the flat list it has always been (the
      // group header would be pure noise when there is nothing to tell apart);
      // two or more sessions each get their own block, labelled with the name the
      // sidebar shows. Sample cards carry no session id, so they always stay flat.
      const runs = runsOf(ordered)
      const grouped = runs.length > 1
      // Every block adds a header line on top of its cards, so the height budget
      // has to grow with the number of blocks or the last card gets clipped.
      // One block costs 6+8 padding + 2 border + 8 gap + a 15.4px 11px header,
      // so 40px keeps a little slack. The gap COUNT is unchanged by grouping
      // ((N-1) between N cards either way), so nothing else needs adjusting.
      position['--ddp-heads'] = grouped ? runs.length * 40 + 'px' : '0px'

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
              className: cx('ddp-handle', canPeek && 'ddp-handle--debug'),
              onPointerDown: beginDrag,
              title: canPeek ? '拖动可调整位置 · 悬停展开示例' : '拖动可调整位置',
            },
            canPeek ? '下载进度条 · 示例预览' : null,
          )

      return h(
        'div',
        {
          ref: wrapRef,
          className: cx(
            'ddp-wrap',
            peeking && !hasReal && 'ddp-wrap--peek',
            drag && 'ddp-wrap--drag',
            resizing && 'ddp-wrap--resizing',
          ),
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
              grouped
                ? runs.map((run, index) =>
                    h(Group, {
                      key: run.key || 'session-' + index,
                      run,
                      showSpeed: settings.showSpeed,
                      ease: settings.enterAnim,
                      phase: leaving ? 'out' : 'in',
                    }),
                  )
                : ordered.map((task, index) =>
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

    /**
     * A labelled <select> row.
     *
     * Four settings differ only in their data (value, label, option list, what
     * they write back), so the markup lives here once instead of being repeated
     * with copy-pasted `className` / `aria-label` / `onChange` wrappers.
     *
     * @param {{label: string, hint?: string, aria: string, value: unknown,
     *          options: {value: string, label: string}[],
     *          onChange: (value: string) => void}} props
     */
    function selectRow(props) {
      return h(
        SettingRow,
        { label: props.label, hint: props.hint },
        h(
          'select',
          {
            className: 'ddp-set-select',
            value: String(props.value),
            'aria-label': props.aria,
            onChange: (event) => props.onChange(event.target.value),
          },
          props.options.map((option) =>
            h('option', { key: option.value, value: option.value }, option.label),
          ),
        ),
      )
    }

    /** Row-count choices for the "max visible cards" setting. */
    const ROW_COUNTS = [1, 2, 3, 4, 5, 6]

    function SettingsPage() {
      const settings = useSettings()
      const set = writeSettings

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
        toggleRow({
          label: '只看当前会话的下载',
          hint: '关闭（默认）：所有会话的下载按会话分块，堆叠在同一个浮层里。打开：只显示当前正打开的会话的下载，切换到别的会话就跟着换成那个会话的进度。当前会话没有下载时浮层不显示。',
          checked: settings.currentOnly,
          onChange: (next) => set({ currentOnly: next }),
        }),
        selectRow({
          label: '新任务的排列位置',
          hint: '同时有多个下载时，最新出现的条目放在列表顶部还是底部。',
          aria: '排列顺序',
          value: settings.order,
          options: [
            { value: 'newest-first', label: '最新在前' },
            { value: 'oldest-first', label: '最新在后' },
          ],
          onChange: (value) => set({ order: value }),
        }),
        selectRow({
          label: '主题',
          hint: '「跟随系统」直接沿用 DSH 当前主题；亮色/暗色只作用于浮层。新增主题只需在 client.js 的 THEMES 里加一项，这个下拉会自动出现新选项。',
          aria: '主题',
          value: settings.theme,
          options: allThemes().map((theme) => ({ value: theme.id, label: theme.label })),
          onChange: (value) => set({ theme: value }),
        }),
        selectRow({
          label: '出现动画',
          hint: '浮层出现 / 收起时的动效。「CRT 开关机」是从一条亮线展开、收起时再缩成亮线消失；「水波纹」是从卡片中心涌出一圈光；「无动画」则瞬间出现。',
          aria: '出现动画',
          value: settings.enterAnim,
          options: ENTER_ANIMS.map((anim) => ({ value: anim.id, label: anim.label })),
          onChange: (value) => set({ enterAnim: value }),
        }),
        selectRow({
          label: '最多同时显示条数',
          hint: '超出的条目在浮层内滚动查看。',
          aria: '最多同时显示条数',
          value: settings.maxVisible,
          options: ROW_COUNTS.map((n) => ({ value: String(n), label: n + ' 条' })),
          // The select yields a string; the setting is a number.
          onChange: (value) => set({ maxVisible: Number(value) }),
        }),
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
