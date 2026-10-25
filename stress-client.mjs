/**
 * Stress + edge-case test for the Client half.
 *
 * `smoke.mjs` proves the happy path renders. This file pushes the overlay where
 * the wire data comes from an untrusted place: fifty cards at once, null and
 * mistyped entries, a 10 KB label, a hung route, a 320 px window, and a broken
 * localStorage value. Every case boots a fresh copy of the bundle, because the
 * module keeps settings cache and drag state at module scope.
 *
 *   node stress-client.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'client.js')
const src = fs.readFileSync(file, 'utf8')

const ok = (message) => console.log('  ok ' + message)

/**
 * Boot one isolated copy of the bundle.
 *
 * @param {object} [options]
 * @param {Array}  [options.tasks]      what the route returns
 * @param {Function} [options.fetchImpl] custom fetch (for failure modes)
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {object} [options.seed]       localStorage seed
 */
function boot(options = {}) {
  const { tasks = [], background = [], width = 1440, height = 900, seed = {}, fetchImpl } = options
  const storage = new Map(Object.entries(seed))
  const listeners = {}
  const timers = []
  const intervals = []
  const cleanups = []
  const setCalls = []

  const fakeWindow = {
    location: { origin: 'http://localhost:41999' },
    innerWidth: width,
    innerHeight: height,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    addEventListener(type, fn) {
      ;(listeners[type] || (listeners[type] = [])).push(fn)
    },
    removeEventListener(type, fn) {
      const list = listeners[type]
      if (!list) return
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    requestAnimationFrame: (fn) => {
      timers.push(fn)
      return timers.length
    },
    cancelAnimationFrame: () => {},
    __ModuleLoader__: {
      load(def) {
        fakeWindow.__loaded = def
      },
    },
  }

  const React = {
    __hooks: 0,
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props || {})
      if (children.length) merged.children = children.length === 1 ? children[0] : children
      return { type, props: merged }
    },
    useState(init) {
      React.__hooks += 1
      const value = typeof init === 'function' ? init() : init
      // The fetched frame is the only state that starts empty; only its setter
      // is recorded, so unrelated setPeeking/setDrag calls do not pollute the
      // poll assertions below.
      if (
        value &&
        typeof value === 'object' &&
        Array.isArray(value.tasks) &&
        value.tasks.length === 0 &&
        Array.isArray(value.background) &&
        value.background.length === 0
      ) {
        return [{ tasks, background }, (v) => setCalls.push(v)]
      }
      return [value, () => {}]
    },
    useEffect(fn) {
      React.__hooks += 1
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
    },
    useRef(init) {
      React.__hooks += 1
      return { current: init === undefined ? null : init }
    },
  }

  // Every request the bundle makes, so a test can tell "warmed before the first
  // render" from "only fetched once a component mounted".
  const fetchCalls = []
  const respond =
    fetchImpl ||
    (() => Promise.resolve({ ok: true, json: async () => ({ tasks, background }) }))

  const sandbox = {
    window: fakeWindow,
    console,
    setInterval: (fn) => {
      intervals.push(fn)
      return intervals.length
    },
    clearInterval: () => {},
    setTimeout: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimeout: () => {},
    fetch: (...args) => {
      fetchCalls.push(args[0])
      return respond(...args)
    },
  }
  sandbox.globalThis = sandbox

  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'client.js' })

  const def = fakeWindow.__loaded
  if (!def) throw new Error('bundle did not call window.__ModuleLoader__.load()')

  const plugin = def.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require("' + name + '")')
  })

  const injectors = {}
  const registrations = []
  plugin.apply({
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject(name, cb) {
        injectors[name] = cb
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
  })

  for (const cb of Object.values(injectors)) cb()
  const bySlot = {}
  for (const { spec, component } of registrations) bySlot[spec.name] = component

  /** Render a slot and return the tree plus the hook count of that render. */
  const render = (slotName) => {
    React.__hooks = 0
    const tree = bySlot[slotName]({ close: () => {} })
    return { tree, hooks: React.__hooks }
  }

  return { render, setCalls, storage, listeners, timers, intervals, cleanups, plugin, fetchCalls }
}

function walk(node, out) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return
  }
  if (typeof node === 'object' && node.props) {
    if (typeof node.type === 'function') {
      walk(node.type(node.props), out)
      return
    }
    walk(node.props.children, out)
  }
}

function findAll(node, className, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, className, out)
    return out
  }
  if (node.props && typeof node.type === 'function') {
    findAll(node.type(node.props), className, out)
    return out
  }
  if (node.props && typeof node.props.className === 'string') {
    if (node.props.className.split(/\s+/).indexOf(className) >= 0) out.push(node)
  }
  if (node.props) findAll(node.props.children, className, out)
  return out
}

/** A frame that has been reset to empty, whichever field the host mangled. */
const isClearedFrame = (v) =>
  !!v &&
  typeof v === 'object' &&
  Array.isArray(v.tasks) &&
  v.tasks.length === 0 &&
  Array.isArray(v.background) &&
  v.background.length === 0

/* ------------------------------------------------------------------ */
/* 1. fifty concurrent cards                                           */
/* ------------------------------------------------------------------ */

{
  const many = []
  for (let i = 0; i < 50; i++) {
    many.push({
      id: 'c' + i,
      kind: i % 2 ? 'download' : 'install',
      label: 'file-' + i + '.bin',
      bytes: i * 1000,
      total: 100000,
      speed: 1000 + i,
      elapsedMs: i * 100,
    })
  }
  const app = boot({ tasks: many })
  const started = Date.now()
  const { tree, hooks } = app.render('shell.overlay')
  const cost = Date.now() - started
  const cards = findAll(tree, 'ddp-card')
  if (cards.length !== 50) throw new Error('expected 50 cards, got ' + cards.length)
  const tips = findAll(tree, 'ddp-tip')
  if (tips.length !== 25) throw new Error('only the 25 downloads carry a percent tip, got ' + tips.length)
  console.log('     (rendering 50 cards took ' + cost + ' ms, ' + hooks + ' hooks)')
  if (cost > 400) throw new Error('50-card render is too slow: ' + cost + ' ms')
  ok('overlay: 50 concurrent cards render with the right determinate/indeterminate split')
}

/* ------------------------------------------------------------------ */
/* 2. hostile wire data                                                */
/* ------------------------------------------------------------------ */

{
  const hostile = [
    null,
    undefined,
    {},
    { id: 'x1', kind: 'download', bytes: 'abc', total: 'nope', speed: undefined },
    { id: 'x2', kind: 'download', bytes: -5, total: -1 },
    { id: 'x3', kind: 'weird-kind', label: 'x'.repeat(10_000) },
    { id: 'x4', kind: 'install', phase: 'applying', log: 'y'.repeat(10_000) },
    { id: 'x5', kind: 'search', label: '' },
  ]
  const app = boot({ tasks: hostile })
  let tree
  try {
    tree = app.render('shell.overlay').tree
  } catch (error) {
    throw new Error('a null or mistyped task crashed the overlay: ' + error.message)
  }
  const texts = []
  walk(tree, texts)
  if (!texts.length) throw new Error('hostile payload rendered nothing at all')
  ok('overlay: null / NaN / negative / 10 KB payloads render without throwing')
}

/* ------------------------------------------------------------------ */
/* 3. the route answering garbage                                      */
/* ------------------------------------------------------------------ */

async function settle() {
  // Let the fetch promise chain inside useTasks finish.
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

{
  const app = boot({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => ({ tasks: 'nope' }) }) })
  app.render('shell.overlay')
  await settle()
  if (!app.setCalls.some((v) => isClearedFrame(v)))
    throw new Error('a non-array tasks field must clear the list, got ' + JSON.stringify(app.setCalls))
  ok('poll: a non-array tasks field is discarded instead of rendered')
}

{
  const app = boot({ fetchImpl: () => Promise.resolve({ ok: false, json: async () => ({}) }) })
  app.render('shell.overlay')
  await settle()
  if (app.setCalls.length !== 0)
    throw new Error('one failed poll must keep the last frame, got ' + JSON.stringify(app.setCalls))
  ok('poll: a single failure keeps the last frame')
}

/* ------------------------------------------------------------------ */
/* 3b. a route that stays down gives up after five consecutive misses  */
/* ------------------------------------------------------------------ */

{
  const app = boot({ fetchImpl: () => Promise.reject(new Error('host gone')) })
  app.render('shell.overlay') // first tick runs inside the effect
  await settle()
  const tick = app.intervals[0]
  if (!tick) throw new Error('the poller did not register its interval')
  // The effect already ran one tick, so three more make four failures: the list
  // must survive all of them.
  for (let i = 0; i < 3; i++) {
    tick()
    await settle()
  }
  if (app.setCalls.length !== 0)
    throw new Error('four failures must still hold the last frame, got ' + JSON.stringify(app.setCalls))
  // The fifth consecutive failure drops it.
  tick()
  await settle()
  if (!app.setCalls.some((v) => isClearedFrame(v)))
    throw new Error('the fifth consecutive failure must clear the list')
  ok('poll: five consecutive misses drop a stale frame instead of freezing forever')
}

/* ------------------------------------------------------------------ */
/* 3c. a recovered route re-arms the failure counter                   */
/* ------------------------------------------------------------------ */

{
  let mode = 'fail'
  const app = boot({
    tasks: [{ id: 'r1', kind: 'download', label: 'r.bin', bytes: 1, total: 2, speed: 1, elapsedMs: 5 }],
    fetchImpl: () =>
      mode === 'fail'
        ? Promise.reject(new Error('host gone'))
        : Promise.resolve({ ok: true, json: async () => ({ tasks: [{ id: 'r1', kind: 'download', bytes: 1 }] }) }),
  })
  app.render('shell.overlay')
  await settle()
  const tick = app.intervals[0]
  for (let i = 0; i < 3; i++) {
    tick()
    await settle()
  }
  mode = 'ok'
  tick()
  await settle()
  const clearedBefore = app.setCalls.some((v) => isClearedFrame(v))
  if (clearedBefore) throw new Error('a successful poll must not clear the list')
  // Four more failures after the success: the counter restarted, so still no clear.
  mode = 'fail'
  for (let i = 0; i < 4; i++) {
    tick()
    await settle()
  }
  if (app.setCalls.some((v) => isClearedFrame(v)))
    throw new Error('the failure counter must restart after a successful poll')
  ok('poll: a successful poll restarts the failure counter')
}

/* ------------------------------------------------------------------ */
/* 3d. one poller feeds every surface                                  */
/* ------------------------------------------------------------------ */

{
  // The overlay and the composer chip are separate slots, so they are separate
  // React trees: nothing but a module-level store can join them. Two loops meant
  // two requests per second for one route and two copies of the list that could
  // disagree for a tick — a bug visible on one surface and not the other.
  const app = boot({
    tasks: [{ id: 's1', kind: 'download', label: 's.bin', bytes: 5, total: 10, speed: 2, elapsedMs: 9 }],
  })
  app.render('shell.overlay')
  await settle()
  app.render('conversation.input.left')
  await settle()
  if (app.intervals.length !== 1)
    throw new Error('both surfaces must share one poller, got ' + app.intervals.length + ' intervals')
  ok('poll: the overlay and the chip share a single poller')
}

/* ------------------------------------------------------------------ */
/* 3e. the store warms up before the first surface mounts              */
/* ------------------------------------------------------------------ */

{
  // Mount order is host's business. The overlay may appear several hundred
  // milliseconds after the plugin loads, and every millisecond before the first
  // frame lands renders an empty overlay. Warming the store at apply() time
  // means the first render already has a frame to replay.
  const app = boot({ tasks: [{ id: 'w1', kind: 'download', bytes: 1, total: 2 }] })
  await settle()
  if (app.fetchCalls.length === 0)
    throw new Error('the store must fetch once while applying, before any surface mounts')
  app.render('shell.overlay')
  await settle()
  if (app.fetchCalls.length < 2)
    throw new Error('mounting must still poll, got ' + app.fetchCalls.length + ' requests')
  ok('poll: the store warms up before the first surface mounts')
}

/* ------------------------------------------------------------------ */
/* 3f. an active frame is chased faster than the idle cadence          */
/* ------------------------------------------------------------------ */

{
  // A real transfer moves every few hundred milliseconds. Waiting the full
  // idle second makes the bar visibly step, so an active frame schedules one
  // short follow-up. The idle cadence stays as-is to keep an empty overlay
  // from polling the host four times a second.
  const app = boot({
    tasks: [{ id: 'f1', kind: 'download', label: 'f.bin', bytes: 10, total: 100, speed: 5, elapsedMs: 50 }],
  })
  const before = app.timers.length
  app.render('shell.overlay')
  await settle()
  if (app.timers.length <= before)
    throw new Error('an active frame must schedule a faster follow-up poll')
  ok('poll: an active frame schedules a faster follow-up')
}

/* ------------------------------------------------------------------ */
/* 4. hook count is identical across every settings combination        */
/* ------------------------------------------------------------------ */

{
  const combos = [
    {},
    { 'dsh-download-progress:settings': JSON.stringify({ debugMode: true }) },
    { 'dsh-download-progress:settings': JSON.stringify({ enabled: false, debugMode: true }) },
    { 'dsh-download-progress:settings': 'not json at all' },
    { 'dsh-download-progress:settings': 'null' },
    { 'dsh-download-progress:settings': JSON.stringify({ maxVisible: 0, x: 999, theme: 'nope', enterAnim: 'nope' }) },
  ]
  let baseline = null
  for (const seed of combos) {
    const app = boot({ seed, tasks: [] })
    const { hooks } = app.render('shell.overlay')
    if (baseline === null) baseline = hooks
    else if (hooks !== baseline)
      throw new Error('hook count changed between settings combos: ' + baseline + ' vs ' + hooks + ' for ' + JSON.stringify(seed))
  }
  ok('overlay: hook count is stable across ' + combos.length + ' settings combinations')
}

/* ------------------------------------------------------------------ */
/* 5. a 320 px window with cards present                               */
/* ------------------------------------------------------------------ */

{
  const app = boot({
    width: 320,
    height: 420,
    tasks: [{ id: 'n', kind: 'download', label: 'a.bin', bytes: 10, total: 100, speed: 5, elapsedMs: 1000 }],
  })
  const tree = app.render('shell.overlay').tree
  const wrap = findAll(tree, 'ddp-wrap')[0]
  if (!wrap) throw new Error('overlay missing in a narrow window')
  // The grab handlers must survive a viewport narrower than the card.
  const move = (app.listeners.pointermove || [])[0]
  if (move) {
    try {
      move({ clientX: -500, clientY: -500 })
      move({ clientX: 9999, clientY: 9999 })
    } catch (error) {
      throw new Error('drag clamped out of range in a narrow window: ' + error.message)
    }
  }
  ok('overlay: a 320 px viewport renders and clamps drag offsets without throwing')
}

/* ------------------------------------------------------------------ */
/* 6. settings page survives a hostile localStorage                    */
/* ------------------------------------------------------------------ */

{
  const app = boot({
    seed: {
      'dsh-download-progress:settings': '\u0000{"broken"',
      'dsh-download-progress:themes': '{"not":"an array"}',
    },
  })
  const tree = app.render('settings.section').tree
  const texts = []
  walk(tree, texts)
  if (!texts.length) throw new Error('settings page rendered nothing')
  ok('settings: broken JSON in both keys still renders the page')
}

/* ------------------------------------------------------------------ */
/* 7. the bundled CSS is present and parse-sane                        */
/* ------------------------------------------------------------------ */

{
  const app = boot()
  app.render('shell.overlay')
  const style = app.storage.get('__style_probe__')
  // The style tag is injected through ctx.effect, not localStorage; assert the
  // bundle itself carries the rules the UI depends on.
  for (const needle of ['.ddp-wrap', '.ddp-card', '.ddp-fill', '@keyframes ddp-ripple-wave']) {
    if (src.indexOf(needle) < 0) throw new Error('CSS is missing ' + needle)
  }
  if ((src.match(/\{/g) || []).length !== (src.match(/\}/g) || []).length)
    throw new Error('unbalanced braces in the CSS template')
  // Regression guard: the card lives in a flex column with a max-height, and it
  // has overflow:hidden — which zeroes its automatic minimum size. Drop this and
  // ten simultaneous downloads squash into hairlines instead of scrolling.
  if (!/\.ddp-card\{[^}]*flex:0 0 auto/.test(src))
    throw new Error('.ddp-card must opt out of flex shrinking')
  // Every card paints a blurred backdrop and a running shine, so a layout change
  // inside one card must not be allowed to reflow its neighbours. `contain` is
  // what scopes it; the card already clips, so paint containment changes nothing
  // visually.
  if (!/\.ddp-card\{[^}]*contain:layout paint/.test(src))
    throw new Error('.ddp-card must scope its own layout with `contain`')
  // Keyframes run *forever* on cards that are on screen for minutes. Animating a
  // layout property (left, margin-left, width, top…) makes the browser re-flow
  // the whole list every frame; the compositor can only carry `transform` and
  // `opacity` for free. This caught the shine and the indeterminate bar.
  //
  // The bodies are extracted by counting braces rather than by a lazy regex:
  // a one-line `@keyframes x{0%{opacity:.35}}` would otherwise swallow every rule
  // that follows it up to the next closing brace at column 0.
  const keyframes = (text) => {
    const out = []
    const head = /@keyframes\s+([\w-]+)\s*\{/g
    let m
    while ((m = head.exec(text))) {
      let depth = 0
      let i = head.lastIndex - 1
      for (; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1
        else if (text[i] === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      out.push({ name: m[1], body: text.slice(head.lastIndex, i) })
      head.lastIndex = i + 1
    }
    return out
  }
  const LAYOUT_KEYS = ['left', 'right', 'top', 'bottom', 'width', 'height', 'margin', 'padding']
  for (const frame of keyframes(src)) {
    const props = [...frame.body.matchAll(/(?:^|[{;])\s*([a-z-]+)\s*:/g)].map((m) => m[1])
    for (const prop of props) {
      if (LAYOUT_KEYS.some((k) => prop === k || prop.startsWith('margin-') || prop.startsWith('padding-')))
        throw new Error('@keyframes ' + frame.name + ' animates `' + prop + '`; use transform instead')
    }
  }
  void style
  ok('css: the stylesheet is present with balanced braces, cards cannot be squashed')
}

console.log('\nCLIENT STRESS OK — 50 cards, hostile payloads, route failures and narrow windows')
