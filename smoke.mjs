/**
 * Offline smoke test for client.js.
 *
 * Loads the client bundle in a fake browser-ish global, captures the
 * __ModuleLoader__ registration, then exercises every component the plugin
 * contributes — without a browser, without React, without the DSH shell.
 *
 * Catches: syntax errors, undefined references, hook-order violations,
 * registration-shape mistakes, and crashes inside the settings page.
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'client.js')
const src = fs.readFileSync(file, 'utf8')

/* ---- fake page globals ---- */
const storage = new Map()
const listeners = {}

// Deferred timers, so the test can decide exactly when a scheduled collapse
// fires. Immediately running them would recurse (the poller and the presence
// machine both schedule themselves).
const timers = []
function fakeSetTimeout(fn) {
  timers.push(fn)
  return timers.length
}
function fakeClearTimeout(id) {
  if (id) timers[id - 1] = null
}
function flushTimers() {
  const pending = timers.splice(0, timers.length)
  for (const fn of pending) {
    if (typeof fn === 'function') fn()
  }
}

const fakeWindow = {
  location: { origin: 'http://localhost:41999' },
  innerWidth: 1440,
  innerHeight: 900,
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
  __ModuleLoader__: {
    load(def) {
      fakeWindow.__loaded = def
    },
  },
}

const sandbox = {
  window: fakeWindow,
  console,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  fetch: () => Promise.resolve({ ok: true, json: async () => ({ tasks: [] }) }),
}
sandbox.globalThis = sandbox

/* ---- third-party themes: one valid, one shadowing a built-in id ---- */
// The dropdown must pick up the custom one and ignore the impostor; the custom
// theme's tokens must be filtered down to --ddp-* colour keys only.
storage.set(
  'dsh-download-progress:themes',
  JSON.stringify([
    {
      id: 'solarized',
      label: 'Solarized',
      tokens: { '--ddp-accent': '#b58900', '--ddp-rows': '9', color: 'red' },
    },
    { id: 'light', label: '冒充内置', tokens: { '--ddp-accent': '#000000' } },
  ]),
)

vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })

const def = fakeWindow.__loaded
if (!def) throw new Error('bundle did not call window.__ModuleLoader__.load()')
console.log('load() ok, id =', def.id)

/* ---- fake React (hooks are inert: one render, no effects) ---- */
// One task per kind the plugin knows how to describe, so the overlay render
// path exercises every branch of describe().
// Mutable so a later block can simulate "nothing is downloading".
// Every canned row belongs to TEST_SESSION, because the inline bar only paints
// the rows of the session whose composer it sits in and a row with no session
// id is intentionally kept out of that filter.
const TEST_SESSION = 'sess-alpha'
const CANNED_TASKS_BASE = [
  { id: 'a', kind: 'download', sessionId: TEST_SESSION, label: 'node-v20.11.0-win-x64.zip', bytes: 12345678, total: 29701389, speed: 5242880, elapsedMs: 3400 },
  { id: 'b', kind: 'install', sessionId: TEST_SESSION, phase: 'installing', log: 'Progress: resolved 42, reused 40', elapsedMs: 9000 },
  { id: 'c', kind: 'fetch', sessionId: TEST_SESSION, elapsedMs: 5200 },
  { id: 'd', kind: 'search', sessionId: TEST_SESSION, label: 'dsh 插件开发文档', elapsedMs: 1200 },
  { id: 'e', kind: 'download', sessionId: TEST_SESSION, unresolved: true, elapsedMs: 7000 },
]
let CANNED_TASKS = CANNED_TASKS_BASE

/**
 * Background rows fed to the same render. Empty by default so every existing
 * assertion keeps seeing the overlay it always saw; the background block below
 * fills this in and re-renders to check the new rows.
 */
let CANNED_BACKGROUND = []

const React = {
  // Counts hook calls per render so a conditional hook shows up as a changed
  // count instead of a mysterious dead overlay in the browser.
  __hooks: 0,
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props || {})
    if (children.length) merged.children = children.length === 1 ? children[0] : children
    return { type, props: merged }
  },
  useState(init) {
    React.__hooks += 1
    const value = typeof init === 'function' ? init() : init
    // The plugin's only list-state is the fetched frame: transfers and
    // background rows together. Seeding both from the canned sets is what makes
    // one synchronous render exercise every branch below.
    if (
      value &&
      typeof value === 'object' &&
      Array.isArray(value.tasks) &&
      value.tasks.length === 0 &&
      Array.isArray(value.background) &&
      value.background.length === 0
    ) {
      return [{ tasks: CANNED_TASKS, background: CANNED_BACKGROUND }, () => {}]
    }
    return [value, () => {}]
  },
  useEffect(fn) {
    React.__hooks += 1
    // Run once so window listeners (the drag session) actually get registered.
    const dispose = fn()
    if (typeof dispose === 'function') cleanups.push(dispose)
  },
  useRef(init) {
    React.__hooks += 1
    return { current: init === undefined ? null : init }
  },
}
const cleanups = []
const fakeRequire = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require("' + name + '")')
}

const plugin = def.factory(fakeRequire)
if (typeof plugin.apply !== 'function') throw new Error('factory did not return apply()')
console.log('inject =', JSON.stringify(plugin.inject))

/* ---- fake host context ---- */
const injectors = {}
const registrations = []
const fakeCtx = {
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
}

plugin.apply(fakeCtx)
console.log('slot injectors =', Object.keys(injectors).join(', '))

/* ---- instantiate every registered slot ---- */
const rendered = {}
for (const [slot, cb] of Object.entries(injectors)) {
  cb()
}
for (const { spec, component } of registrations) {
  const label = typeof spec.label === 'function' ? spec.label() : spec.label
  console.log(`register ${spec.name} id=${spec.id} order=${spec.order} label=${JSON.stringify(label)}`)
  if (typeof spec.id !== 'string' || !spec.id) throw new Error(spec.name + ': missing id')
  if (typeof component !== 'function') throw new Error(spec.name + ': component is not a function')
  // The composer bar is idle by default (nothing of this session is downloading),
  // so rendering nothing is correct there and asserted in its own block below.
  // The two always-present slots must always paint.
  const optional = spec.name === 'conversation.input.left'
  const tree = component({ close: () => {}, sessionId: TEST_SESSION })
  if (tree === undefined) throw new Error(spec.name + ': component returned undefined')
  if (tree === null) {
    if (!optional) throw new Error(spec.name + ': component rendered nothing (null)')
    console.log('  (idle: renders nothing, checked below)')
    continue
  }
  rendered[spec.name] = tree
}

/* ---- walk the settings tree: every text node must be a string/number ---- */
// Function components are invoked so the walk sees real host elements.
function walk(node, depth, out) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, depth, out)
    return
  }
  if (typeof node === 'object' && node.props) {
    if (typeof node.type === 'function') {
      walk(node.type(node.props), depth + 1, out)
      return
    }
    walk(node.props.children, depth + 1, out)
  }
}

/* ---- overlay: one card per task, percent only where a total is known ---- */
function findByClass(node, className, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findByClass(child, className, out)
    return out
  }
  if (node.props && typeof node.type === 'function') {
    findByClass(node.type(node.props), className, out)
    return out
  }
  if (node.props && typeof node.props.className === 'string') {
    if (node.props.className.split(/\s+/).indexOf(className) >= 0) out.push(node)
  }
  if (node.props) findByClass(node.props.children, className, out)
  return out
}

const overlayTree = rendered['shell.overlay']
const cards = findByClass(overlayTree, 'ddp-card')
const tips = findByClass(overlayTree, 'ddp-tip')
const indet = findByClass(overlayTree, 'ddp-fill--indet')
const wrap = findByClass(overlayTree, 'ddp-wrap')
console.log('\noverlay: cards =', cards.length, 'tips =', tips.length, 'indeterminate =', indet.length)
if (cards.length !== CANNED_TASKS.length) throw new Error('expected one card per task')
if (tips.length !== 1) throw new Error('only the task with a known total may show a percent tip')
if (indet.length !== CANNED_TASKS.length - 1) throw new Error('every task without a total must be indeterminate')
if (!wrap.length) throw new Error('overlay wrapper missing')

/* ---- default placement: near the top, horizontally centred, above dialogs ---- */
const wrapStyle = wrap[0].props.style
console.log('wrap style =', JSON.stringify(wrapStyle))
if (wrapStyle.top !== '76px') throw new Error('default top should be 76px, got ' + wrapStyle.top)
if (wrapStyle.left !== '50%' || wrapStyle.transform !== 'translateX(-50%)')
  throw new Error('default placement should be horizontally centred')
if (wrapStyle['--ddp-rows'] !== '3') throw new Error('overlay must publish --ddp-rows from settings')
if (!String(wrap[0].props.className).includes('ddp-wrap')) throw new Error('wrap class missing')

/* ---- ordering: default newest-first reverses the host order ---- */
const names = findByClass(overlayTree, 'ddp-name').map((n) => n.props.children)
console.log('card order =', JSON.stringify(names))
if (names[0] !== '载入中...' || names[names.length - 1] !== 'node-v20.11.0-win-x64.zip')
  throw new Error('newest-first should reverse the host order, got ' + JSON.stringify(names))

const overlayText = []
walk(overlayTree, 0, overlayText)
console.log('overlay texts:')
for (const t of overlayText) console.log('  -', String(t))
for (const needle of ['11.8 MB / 28.3 MB · 5.00 MB/s', '插件安装中...下载中...', '正在抓取网页中...5s', '正在搜索「dsh 插件开发文档」中...请稍后', '载入中...']) {
  if (!overlayText.some((t) => String(t).indexOf(needle) >= 0)) throw new Error('overlay is missing: ' + needle)
}
console.log('  ok all five overlay variants')

CANNED_TASKS = CANNED_TASKS_BASE

/* ---- settings page ---- */

const settingsTree = rendered['settings.section']
const texts = []
walk(settingsTree, 0, texts)
console.log('\nsettings page text nodes (' + texts.length + '):')
for (const t of texts) console.log('  -', String(t))

const required = ['显示下载进度浮层', '显示下载速度', '新任务的排列位置', '最多同时显示条数', '浮层位置']
for (const needle of required) {
  const hit = texts.some((t) => String(t).indexOf(needle) >= 0)
  if (!hit) throw new Error('settings page is missing row: ' + needle)
  console.log('  ok row:', needle)
}
if (texts.some((t) => String(t).indexOf('预览') >= 0))
  throw new Error('the debug preview rows must be gone')
if (texts.some((t) => String(t).indexOf('底部居中') >= 0))
  throw new Error('the old fixed-position select must be gone')

/* ---- controls: 3 checkboxes (enabled / speed / preview) + 3 selects + 1 button ---- */
function countOptions(selectNode) {
  let n = 0
  ;(function scan(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(scan)
    if (node.type === 'option') n += 1
    if (node.props) scan(node.props.children)
  })(selectNode.props.children)
  return n
}

const controls = []
;(function collect(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach(collect)
  if (node.props) {
    if (node.type === 'input') controls.push({ kind: 'input', type: node.props.type, node })
    if (node.type === 'select') controls.push({ kind: 'select', options: countOptions(node), node })
    if (node.type === 'button') controls.push({ kind: 'button', node })
    collect(node.props.children)
  }
})(settingsTree)

console.log('\ncontrols:', JSON.stringify(controls.map((c) => ({ kind: c.kind, type: c.type, options: c.options }))))
const checkboxes = controls.filter((c) => c.kind === 'input' && c.type === 'checkbox')
const selects = controls.filter((c) => c.kind === 'select')
const buttons = controls.filter((c) => c.kind === 'button')
// Five toggles: 浮层开关 / 速度 / 深度进度 / 调试模式 / 只看当前会话。
if (checkboxes.length !== 5) throw new Error('expected 5 checkboxes, got ' + checkboxes.length)
if (selects.length !== 5) throw new Error('expected 5 selects, got ' + selects.length)
if (buttons.length !== 1) throw new Error('expected the reset-position button')

const displaySelect = selects.find((c) => c.node.props['aria-label'] === '显示方式')
if (!displaySelect) throw new Error('settings page is missing the display-mode dropdown')
if (displaySelect.options !== 3)
  throw new Error('display select should offer overlay / inline / both, got ' + displaySelect.options)
const displayValues = []
;(function scan(root) {
  if (!root || typeof root !== 'object') return
  if (Array.isArray(root)) return root.forEach(scan)
  if (root.type === 'option') displayValues.push(root.props.value)
  if (root.props) scan(root.props.children)
})(displaySelect.node)
console.log('  display options =', JSON.stringify(displayValues))
if (JSON.stringify(displayValues) !== JSON.stringify(['overlay', 'inline', 'both']))
  throw new Error('display options must be overlay / inline / both')
if (displaySelect.node.props.value !== 'overlay')
  throw new Error('display must default to the overlay, so upgrading changes nothing on screen')
if (!selects.some((c) => c.node.props['aria-label'] === '排列顺序' && c.options === 2))
  throw new Error('order select should have 2 options')
if (!selects.some((c) => c.node.props['aria-label'] === '最多同时显示条数' && c.options === 6))
  throw new Error('maxVisible select should have 6 options')
const themeSelect = selects.find((c) => c.node.props['aria-label'] === '主题')
if (!themeSelect) throw new Error('settings page is missing the theme dropdown')
if (themeSelect.options !== 4)
  throw new Error(
    'theme dropdown should list 3 built-ins + 1 custom theme, got ' + themeSelect.options,
  )

const debugToggle = checkboxes.find((c) => c.node.props['aria-label'] === '调试模式（显示模拟数据）')

// The depth-progress switch must exist, default off, and say what it costs.
const depthToggle = checkboxes.find(
  (c) => c.node.props['aria-label'] === '启用深度进度（需重启应用生效）',
)
if (!depthToggle) throw new Error('settings page is missing the depth-progress switch')
if (depthToggle.node.props.checked !== false)
  throw new Error('depth progress must default to off — it patches the host HTTP client')
if (!debugToggle) throw new Error('settings page is missing the debug-mode toggle')
if (debugToggle.node.props.checked !== false)
  throw new Error('debug mode must default to off so samples cannot be mistaken for real downloads')

const easeSelect = selects.find((c) => c.node.props['aria-label'] === '出现动画')
if (!easeSelect) throw new Error('settings page is missing the enter-animation dropdown')
if (easeSelect.options !== 11)
  throw new Error('enter-animation dropdown should list 11 feels, got ' + easeSelect.options)

/* ---- debug mode off: no real tasks means the overlay renders nothing ---- */
CANNED_TASKS = []
const overlaySlot = registrations.find((r) => r.spec.name === 'shell.overlay')

const hookCounts = []
// The overlay reads the current session through the `useSessions` standard
// prop. The smoke harness supplies its own selector hook and flips the snapshot
// below, which is how "the user switched session" is simulated offline.
let SESSIONS = { byId: {} }
function fakeUseSessions(selector) {
  React.__hooks += 1
  return selector(SESSIONS)
}
function renderOverlay(props) {
  React.__hooks = 0
  const tree = overlaySlot.component(
    Object.assign({ close: () => {}, useSessions: fakeUseSessions }, props),
  )
  const count = React.__hooks
  if (hookCounts.length && hookCounts[0] !== count)
    throw new Error(
      'conditional hook: first render used ' + hookCounts[0] + ' hooks, this one used ' + count +
        ' — React throws "Rendered fewer hooks than expected" and the overlay dies for good',
    )
  hookCounts.push(count)
  return tree
}

const quietTree = renderOverlay()
console.log('\nidle overlay (debug off):', JSON.stringify(quietTree))
if (quietTree !== null)
  throw new Error('with debug mode off and no tasks the overlay must render nothing, got ' + JSON.stringify(quietTree))
console.log('  ok idle = nothing at all while debug mode is off')

/* ---- debug mode on: the samples reveal themselves, no hover needed ---- */
debugToggle.node.props.onChange({ target: { checked: true } })
// First pass runs the effect that flips the module-level peek flag; the second
// one is what the user actually sees.
renderOverlay()
let idleTree = renderOverlay()
const idleHandle = findByClass(idleTree, 'ddp-handle')
console.log('  idle overlay (debug on): handle =', idleHandle.length,
  '| labelled =', idleHandle.filter((n) => String(n.props.className).includes('ddp-handle--debug')).length,
  '| cards =', findByClass(idleTree, 'ddp-card').length,
  '| list =', findByClass(idleTree, 'ddp-list').length)
if (!idleHandle.length) throw new Error('debug mode must show the drag handle')
if (!idleHandle.some((n) => String(n.props.className).includes('ddp-handle--debug')))
  throw new Error('debug mode must label the grip so the toggle has a visible effect')
if (findByClass(idleTree, 'ddp-card').length !== 5)
  throw new Error('debug mode must reveal the sample cards right away, got ' +
    findByClass(idleTree, 'ddp-card').length)
console.log('  ok debug mode = labelled grip + 5 sample cards immediately')

/* ---- enter animation: every card carries the class, not the list ---- */
const cardsOf = (tree) => findByClass(tree, 'ddp-card')
const cardClassOf = (tree) => {
  const card = cardsOf(tree)[0]
  return (card && card.props && card.props.className) || ''
}
const listClassOf = (tree) => {
  const list = findByClass(tree, 'ddp-list')[0]
  return (list && list.props && list.props.className) || ''
}
console.log('\ncard class (default):', cardClassOf(idleTree), '| list:', listClassOf(idleTree))
if (!/ddp-ease-float/.test(cardClassOf(idleTree)))
  throw new Error('default enter animation must be float, on every card')
if (!/ddp-anim--in/.test(cardClassOf(idleTree)))
  throw new Error('a freshly shown card must carry the enter class')
if (/ddp-ease-|ddp-anim--/.test(listClassOf(idleTree)))
  throw new Error('the animation must live on each card, not on the list container')
const staggered = cardsOf(idleTree).map((card) => (card.props.style || {}).animationDelay)
console.log('  stagger delays:', staggered.join(' / '))
if (staggered[0] !== undefined) throw new Error('the first card must animate immediately')
if (staggered[1] !== '55ms') throw new Error('later cards must be staggered, got ' + staggered[1])
easeSelect.node.props.onChange({ target: { value: 'crt' } })
const crtTree = renderOverlay()
if (!/ddp-ease-crt/.test(cardClassOf(crtTree))) throw new Error('crt feel must reach every card')
if (cardsOf(crtTree).some((card) => !/ddp-ease-crt/.test(card.props.className)))
  throw new Error('every card in the stack must carry the same feel')
easeSelect.node.props.onChange({ target: { value: 'ripple' } })
const rippleTree = renderOverlay()
if (!/ddp-ease-ripple/.test(cardClassOf(rippleTree)))
  throw new Error('ripple feel must reach every card')
if (cardsOf(rippleTree).some((card) => !/ddp-ease-ripple/.test(card.props.className)))
  throw new Error('every card in the stack must carry the same feel')
easeSelect.node.props.onChange({ target: { value: 'none' } })
if (!/ddp-ease-none/.test(cardClassOf(renderOverlay())))
  throw new Error('none feel must reach every card')

/* Every feel the dropdown offers has to be wired at both ends: the card must
   pick up its class, and the bundle must actually ship the keyframes. A feel
   that is listed but has no @keyframes silently does nothing on screen, which
   is exactly the failure a hand-written table invites. */
const busyFeels = []
const feelOptions = []
;(function scan(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach(scan)
  if (node.type === 'option' && node.props && typeof node.props.value === 'string')
    feelOptions.push(node.props.value)
  if (node.props) scan(node.props.children)
})(easeSelect.node.props.children)
feelOptions.forEach((id) => {
  if (id === 'none') return
  easeSelect.node.props.onChange({ target: { value: id } })
  const tree = renderOverlay()
  if (!new RegExp('ddp-ease-' + id + '\\b').test(cardClassOf(tree)))
    throw new Error('feel "' + id + '" is in the dropdown but never reaches a card')
  if (cardsOf(tree).some((card) => !new RegExp('ddp-ease-' + id + '\\b').test(card.props.className)))
    throw new Error('feel "' + id + '" must reach every card in the stack')
  if (src.indexOf('.ddp-anim--in.ddp-ease-' + id) < 0)
    throw new Error('feel "' + id + '" has no CSS rule, so it would animate nothing')
  if (src.indexOf('@keyframes ddp-' + id + '-in') < 0)
    throw new Error('feel "' + id + '" has no @keyframes ddp-' + id + '-in')
  busyFeels.push(id)
})
if (busyFeels.length < 10)
  throw new Error('expected at least 10 animated feels (plus none), got ' + busyFeels.length)
console.log('  feels wired end to end:', busyFeels.join(' / '))
easeSelect.node.props.onChange({ target: { value: 'float' } })
console.log('  ok enter animation = ddp-ease-<id> per card, staggered, never on the list')

/* ---- theme: the wrapper carries --ddp-* overrides, auto carries none ---- */
// Layout variables are written by the overlay itself, never by a theme, so they
// are excluded from every "did the theme touch this?" check below.
const LAYOUT_VARS = ['--ddp-rows', '--ddp-heads', '--ddp-bg']
const themeKeys = (style) =>
  Object.keys(style || {}).filter((k) => k.indexOf('--ddp-') === 0 && LAYOUT_VARS.indexOf(k) < 0)

const autoStyle = idleTree.props.style || {}
console.log('\ntheme auto overrides:', themeKeys(autoStyle).length)
if (themeKeys(autoStyle).length)
  throw new Error('auto theme must not override host tokens, it should fall through to --dsw-alias-*')
if (autoStyle.top !== '76px') throw new Error('auto theme must still position the wrapper')

themeSelect.node.props.onChange({ target: { value: 'light' } })
const lightStyle = renderOverlay().props.style || {}
console.log('  light: --ddp-fg =', lightStyle['--ddp-fg'], '| --ddp-card-bg =', lightStyle['--ddp-card-bg'])
if (lightStyle['--ddp-fg'] !== '#1b1b1f') throw new Error('light theme must set --ddp-fg')
if (!lightStyle['--ddp-card-bg']) throw new Error('light theme must set a card background')
if (lightStyle.top !== '76px') throw new Error('theme tokens must not clobber the position')

themeSelect.node.props.onChange({ target: { value: 'dark' } })
const darkStyle = renderOverlay().props.style || {}
console.log('  dark:  --ddp-fg =', darkStyle['--ddp-fg'])
if (darkStyle['--ddp-fg'] !== '#e8e8ea') throw new Error('dark theme must set --ddp-fg')

themeSelect.node.props.onChange({ target: { value: 'auto' } })
const backToAuto = renderOverlay().props.style || {}
if (themeKeys(backToAuto).length)
  throw new Error('switching back to auto must drop every override')
console.log('  ok theme = css custom properties, auto falls through to host tokens')

/* ---- third-party theme: appears in the dropdown, tokens sanitised ---- */
const themeLabels = themeSelect.node.props.children.map((node) => node.props.children)
console.log('\ntheme dropdown:', themeLabels.join(' / '))
if (themeLabels[3] !== 'Solarized')
  throw new Error('the custom theme should be the 4th option, got ' + themeLabels[3])
if (themeLabels.indexOf('冒充内置') >= 0)
  throw new Error('a custom theme must not shadow a built-in id')
themeSelect.node.props.onChange({ target: { value: 'solarized' } })
const customStyle = renderOverlay().props.style || {}
console.log('  custom tokens kept:', Object.keys(customStyle).filter((k) => k.indexOf('--ddp-') === 0).join(','))
if (customStyle['--ddp-accent'] !== '#b58900')
  throw new Error('the custom theme must set --ddp-accent')
if (customStyle['--ddp-rows'] === '9')
  throw new Error('--ddp-rows is layout, a theme must not be able to override it')
if ('color' in customStyle) throw new Error('only --ddp-* keys may reach the wrapper')
console.log('  ok custom theme loaded from localStorage, --ddp-rows and non-ddp keys rejected')
themeSelect.node.props.onChange({ target: { value: 'auto' } })
renderOverlay()

/* ---- leaving collapses back to the labelled grip ---- */
idleTree.props.onPointerOut({ currentTarget: null })
flushTimers()
const collapsedTree = renderOverlay()
console.log('  collapsed after leave: cards =', findByClass(collapsedTree, 'ddp-card').length,
  '| handle =', findByClass(collapsedTree, 'ddp-handle').length)
if (findByClass(collapsedTree, 'ddp-card').length)
  throw new Error('leaving must collapse the samples back to the grip')
if (!findByClass(collapsedTree, 'ddp-handle').length)
  throw new Error('the labelled grip must stay reachable after collapsing')
console.log('  ok leave = grip only')

/* ---- hovering the grip reveals one sample card per shape ---- */
collapsedTree.props.onPointerOver({ currentTarget: null })
let peekTree = renderOverlay()
let peekCards = findByClass(peekTree, 'ddp-card')
let peekText = []
walk(peekTree, 0, peekText)
console.log('  peek cards =', peekCards.length, '| texts:', JSON.stringify(peekText))
if (peekCards.length !== 5) throw new Error('peek should render all 5 sample shapes, got ' + peekCards.length)
for (const needle of ['node-v20.11.0-win-x64.zip', '插件安装中...下载中...', '正在抓取网页中...', '正在搜索「下载进度条 插件开发」中...请稍后', '安装 Python 包中...']) {
  if (!peekText.some((t) => String(t).indexOf(needle) >= 0)) throw new Error('peek missing: ' + needle)
}
if (!findByClass(peekTree, 'ddp-anim--in').length) throw new Error('peek must play the enter animation')
if (!String(peekTree.props.className).includes('ddp-wrap--peek'))
  throw new Error('peek must draw the outline class')
if (!findByClass(peekTree, 'ddp-tip').length) throw new Error('peek download card needs a percent tip')
const peekLogs = findByClass(peekTree, 'ddp-log')
console.log('  peek log lines =', peekLogs.length)
if (peekLogs.length !== 5)
  throw new Error('every card needs one log line under the bar, got ' + peekLogs.length)
console.log('  ok peek shows all sample shapes')

/* ---- leaving is delayed: a quick hop back onto the cards must not collapse ---- */
peekTree.props.onPointerOut({ currentTarget: null })
// Pointer returns onto the list before the grace period elapses.
peekTree.props.onPointerOver({ currentTarget: null })
flushTimers()
const afterReturn = renderOverlay()
console.log('  returned within grace: cards =', findByClass(afterReturn, 'ddp-card').length)
if (findByClass(afterReturn, 'ddp-card').length !== 5)
  throw new Error('returning within the grace period must keep the peek open')
console.log('  ok grace period cancels the collapse')

/* ---- leaving and waiting out the grace period hides everything again ---- */
peekTree.props.onPointerOut({ currentTarget: null })
flushTimers()
const afterLeave = renderOverlay()
console.log('  after leave + grace: cards =', findByClass(afterLeave, 'ddp-card').length,
  '| handle =', findByClass(afterLeave, 'ddp-handle').length)
if (findByClass(afterLeave, 'ddp-card').length) throw new Error('cards must vanish once the grace period elapses')
if (!findByClass(afterLeave, 'ddp-handle').length) throw new Error('handle must come back after the pointer leaves')
console.log('  ok leave hides the list')

/* ---- toggling debug mode off and back on must bring the samples back ---- */
debugToggle.node.props.onChange({ target: { checked: false } })
renderOverlay()
const offAgain = renderOverlay()
if (offAgain !== null) throw new Error('debug mode off must render nothing again, got ' + JSON.stringify(offAgain))
console.log('  ok toggled off = nothing')
debugToggle.node.props.onChange({ target: { checked: true } })
renderOverlay()
const backOn = renderOverlay()
const backCards = findByClass(backOn, 'ddp-card')
console.log('  toggled back on: cards =', backCards.length, '| handle =', findByClass(backOn, 'ddp-handle').length)
if (backCards.length !== 5)
  throw new Error('toggling debug mode back on must restore the samples, got ' + backCards.length)
if (!findByClass(backOn, 'ddp-handle').length) throw new Error('the grip must be back too')
console.log('  ok debug mode survives an off/on cycle')

/* ---- real tasks: no handle, exactly one card per real task ---- */
CANNED_TASKS = [
  { id: 'x', kind: 'download', label: 'a.bin', bytes: 10, total: 100, speed: 5, elapsedMs: 1000 },
]
const oneTree = renderOverlay()
const oneCards = findByClass(oneTree, 'ddp-card')
console.log('  one real task: cards =', oneCards.length, '| handle =', findByClass(oneTree, 'ddp-handle').length)
if (oneCards.length !== 1) throw new Error('one real task must render exactly one card, got ' + oneCards.length)
if (findByClass(oneTree, 'ddp-handle').length) throw new Error('the handle must be hidden while a real task runs')
if (oneTree.props.style['--ddp-rows'] !== '3') throw new Error('real tasks must still publish the row cap')
console.log('  ok one real task = one card, no handle')

/* ---- one session: no grouping, the flat list is untouched ----
   The wrapper must stay byte-for-byte what it was before session blocks
   existed, otherwise every single-download user pays for a feature they
   cannot see. */
CANNED_TASKS = [
  { id: 's1a', kind: 'download', label: 'a.bin', bytes: 10, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-aaaa1111', sessionTitle: '整理素材库' },
  { id: 's1b', kind: 'download', label: 'b.bin', bytes: 20, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-aaaa1111', sessionTitle: '整理素材库' },
]
const oneSessionTree = renderOverlay()
const oneSessionGroups = findByClass(oneSessionTree, 'ddp-group')
console.log('\none session: groups =', oneSessionGroups.length, '| cards =', findByClass(oneSessionTree, 'ddp-card').length)
if (oneSessionGroups.length) throw new Error('a single session must not be boxed into a block')
if (oneSessionTree.props.style['--ddp-heads'] !== '0px')
  throw new Error('an ungrouped list must reserve no header height, got ' + oneSessionTree.props.style['--ddp-heads'])
console.log('  ok one session = flat list, no block, no reserved header height')

/* ---- two sessions: one block each, labelled with the session name ---- */
CANNED_TASKS = [
  { id: 'm1', kind: 'download', label: 'x.bin', bytes: 10, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-aaaa1111', sessionTitle: '整理素材库' },
  { id: 'm2', kind: 'download', label: 'y.bin', bytes: 20, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-bbbb2222', sessionTitle: '打包发行版' },
]
const multiTree = renderOverlay()
const multiGroups = findByClass(multiTree, 'ddp-group')
const multiNames = multiGroups.map((g) => findByClass(g, 'ddp-group-name')[0].props.children)
console.log('two sessions: groups =', multiGroups.length, '| names =', JSON.stringify(multiNames))
if (multiGroups.length !== 2) throw new Error('two sessions must render two blocks, got ' + multiGroups.length)
if (findByClass(multiTree, 'ddp-card').length !== 2) throw new Error('every task must still render inside its block')
// newest-first is the default: the last task on the wire is drawn on top.
if (multiNames[0] !== '打包发行版' || multiNames[1] !== '整理素材库')
  throw new Error('blocks must follow the chosen order, got ' + JSON.stringify(multiNames))
if (multiTree.props.style['--ddp-heads'] !== '80px')
  throw new Error('two blocks must reserve two header lines, got ' + multiTree.props.style['--ddp-heads'])
console.log('  ok two sessions = two labelled blocks, order preserved, header height reserved')

/* ---- the label is the session title; without one, a short id instead ---- */
CANNED_TASKS = [
  { id: 'n1', kind: 'download', label: 'x.bin', bytes: 10, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-aaaa1111', sessionTitle: '整理素材库' },
  { id: 'n2', kind: 'download', label: 'y.bin', bytes: 20, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-cccc3333' },
]
const fallbackTree = renderOverlay()
const fallbackNames = findByClass(fallbackTree, 'ddp-group').map(
  (g) => findByClass(g, 'ddp-group-name')[0].props.children,
)
console.log('  untitled session label =', JSON.stringify(fallbackNames))
if (fallbackNames.indexOf('会话 cccc3333') < 0)
  throw new Error('a session without a title must fall back to a short id, got ' + JSON.stringify(fallbackNames))
console.log('  ok label = session title, falling back to 会话 <id tail>')

/* ---- a session with several downloads says how many ---- */
CANNED_TASKS = [
  { id: 'p1', kind: 'download', label: 'x.bin', bytes: 10, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-aaaa1111', sessionTitle: '整理素材库' },
  { id: 'p2', kind: 'download', label: 'y.bin', bytes: 20, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-aaaa1111', sessionTitle: '整理素材库' },
  { id: 'p3', kind: 'download', label: 'z.bin', bytes: 30, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-bbbb2222', sessionTitle: '打包发行版' },
]
const countTree = renderOverlay()
const countBlocks = findByClass(countTree, 'ddp-group')
// Newest-first is the default, so the blocks come back reversed. Match by name
// instead of by index, otherwise the test only proves the order by accident.
const blockNamed = (name) =>
  countBlocks.find((g) => findByClass(g, 'ddp-group-name')[0].props.children === name)
const badgeOf = (name) => findByClass(blockNamed(name), 'ddp-group-count')[0]
console.log('  badges =', JSON.stringify(countBlocks.map((g) => {
  const badge = findByClass(g, 'ddp-group-count')[0]
  return [findByClass(g, 'ddp-group-name')[0].props.children, badge ? badge.props.children : null]
})))
// Only the session that holds more than one card gets a count; a lone card
// under a header that already says "1" would be noise.
const twoBadge = badgeOf('整理素材库')
if (!twoBadge || twoBadge.props.children !== '2 项')
  throw new Error('the session with two cards must be labelled "2 项"')
if (badgeOf('打包发行版')) throw new Error('a session with one card must not show a count')
console.log('  ok multi-card sessions carry a count, single-card sessions do not')

/* ---- samples belong to no session, so a peek stays flat ---- */
CANNED_TASKS = []
const sampleTree = renderOverlay()
console.log('  debug peek: groups =', findByClass(sampleTree, 'ddp-group').length, '| cards =', findByClass(sampleTree, 'ddp-card').length)
if (findByClass(sampleTree, 'ddp-group').length)
  throw new Error('sample cards have no session and must render as the flat list')
console.log('  ok debug peek = flat samples, no invented session blocks')

/* ---- current-session scope: only the session the main view shows ---- */
// Two sessions with one download each, plus the session snapshot the overlay
// reads through `useSessions`. Switching the snapshot IS a session switch.
const TWO_SESSIONS = [
  { id: 'q1', kind: 'download', label: 'x.bin', bytes: 10, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-aaaa1111', sessionTitle: '整理素材库' },
  { id: 'q2', kind: 'download', label: 'y.bin', bytes: 20, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-bbbb2222', sessionTitle: '打包发行版' },
]
const scopeToggle = checkboxes.find((c) => c.node.props['aria-label'] === '只看当前会话的下载')
if (!scopeToggle) throw new Error('settings page is missing the current-session toggle')
if (scopeToggle.node.props.checked !== false)
  throw new Error('the current-session scope must default to off, so the stacked list stays the default')

CANNED_TASKS = TWO_SESSIONS
SESSIONS = { byId: { 'sess-bbbb2222': { id: 'sess-bbbb2222', retainedBy: { mainView: 1 } } } }
scopeToggle.node.props.onChange({ target: { checked: true } })
const scopedTree = renderOverlay()
const scopedNames = findByClass(scopedTree, 'ddp-name').map((n) => n.props.children)
console.log('\ncurrentOnly on, main view = 打包发行版: cards =', scopedNames.length,
  '| names =', JSON.stringify(scopedNames),
  '| groups =', findByClass(scopedTree, 'ddp-group').length)
if (scopedNames.length !== 1 || scopedNames[0] !== 'y.bin')
  throw new Error('the current-session scope must hide other sessions, got ' + JSON.stringify(scopedNames))
if (findByClass(scopedTree, 'ddp-group').length)
  throw new Error('one visible session must stay a flat list, no block')
if (scopedTree.props.style['--ddp-heads'] !== '0px')
  throw new Error('a scoped single session must reserve no header height, got ' + scopedTree.props.style['--ddp-heads'])
console.log('  ok scoped = only the open session, still flat, no header height')

// Switching session swaps the progress: same tasks, other session on screen.
SESSIONS = { byId: { 'sess-aaaa1111': { id: 'sess-aaaa1111', retainedBy: { mainView: 1 } } } }
const switchedTree = renderOverlay()
const switchedNames = findByClass(switchedTree, 'ddp-name').map((n) => n.props.children)
console.log('  switched to 整理素材库: cards =', JSON.stringify(switchedNames))
if (switchedNames.length !== 1 || switchedNames[0] !== 'x.bin')
  throw new Error('switching session must switch the shown progress, got ' + JSON.stringify(switchedNames))
console.log('  ok switching session swaps the visible progress')

// Three sessions downloading at once: the open one still gets the whole overlay.
CANNED_TASKS = TWO_SESSIONS.concat([
  { id: 'q3', kind: 'download', label: 'z.bin', bytes: 30, total: 100, speed: 5, elapsedMs: 1000, sessionId: 'sess-cccc3333', sessionTitle: '清理缓存' },
])
const threeTree = renderOverlay()
const threeNames = findByClass(threeTree, 'ddp-name').map((n) => n.props.children)
console.log('  three sessions, scoped: cards =', JSON.stringify(threeNames))
if (threeNames.length !== 1 || threeNames[0] !== 'x.bin')
  throw new Error('three concurrent sessions must still show only the open one, got ' + JSON.stringify(threeNames))

// A right-hand panel owns the main key, so no session is current. Falling back
// to the full list beats going blank with downloads visibly running.
SESSIONS = { byId: { 'sess-aaaa1111': { id: 'sess-aaaa1111', retainedBy: {} } } }
const noSessionTree = renderOverlay()
console.log('  no current session: cards =', findByClass(noSessionTree, 'ddp-card').length,
  '| groups =', findByClass(noSessionTree, 'ddp-group').length)
if (findByClass(noSessionTree, 'ddp-card').length !== 3)
  throw new Error('an unknown current session must fall back to the full list, not hide everything')
console.log('  ok unknown current session = full list, never a blank overlay')

// A row with no session id (older host) cannot be attributed, so it is kept.
CANNED_TASKS = TWO_SESSIONS.concat([
  { id: 'q4', kind: 'download', label: 'legacy.bin', bytes: 40, total: 100, speed: 5, elapsedMs: 1000 },
])
SESSIONS = { byId: { 'sess-aaaa1111': { id: 'sess-aaaa1111', retainedBy: { mainView: 1 } } } }
const legacyNames = findByClass(renderOverlay(), 'ddp-name').map((n) => n.props.children)
console.log('  scoped + unattributed row: cards =', JSON.stringify(legacyNames))
if (legacyNames.indexOf('legacy.bin') < 0)
  throw new Error('a row without a session id must never be filtered out, got ' + JSON.stringify(legacyNames))
console.log('  ok rows without a session id survive the scope')

// Off again: both sessions come back as blocks, exactly as before the feature.
CANNED_TASKS = TWO_SESSIONS
SESSIONS = { byId: {} }
scopeToggle.node.props.onChange({ target: { checked: false } })
const unscopedTree = renderOverlay()
console.log('  currentOnly off: groups =', findByClass(unscopedTree, 'ddp-group').length,
  '| cards =', findByClass(unscopedTree, 'ddp-card').length)
if (findByClass(unscopedTree, 'ddp-group').length !== 2)
  throw new Error('turning the scope off must restore the stacked per-session blocks')
console.log('  ok scope off = the stacked list again')

/* ---- the session name must be legible, not the dim token ---- */
// Reported bug: the block header was almost invisible on the glass material.
// The header now reads the primary foreground; a dim token there is the bug.
const groupHeadRule = (src.match(/\.ddp-group-head\{[^}]*\}/) || [''])[0]
console.log('\n.ddp-group-head colour:', (groupHeadRule.match(/color:[^;]+/) || [''])[0])
if (!groupHeadRule) throw new Error('.ddp-group-head rule is missing')
if (groupHeadRule.indexOf('--ddp-fg-dim') >= 0)
  throw new Error('the session name must not use the dim foreground, that is the too-faint bug')
if (groupHeadRule.indexOf('var(--ddp-fg,') < 0)
  throw new Error('the session name should fall back to the primary foreground')
if (!/--ddp-group-fg/.test(groupHeadRule))
  throw new Error('the header needs its own --ddp-group-fg knob so a theme can tune it alone')
const groupNameRule = (src.match(/\.ddp-group-name\{[^}]*\}/) || [''])[0]
if (!/font-weight:600/.test(groupNameRule))
  throw new Error('the session name should be semibold so it reads as a header')
console.log('  ok session name = primary foreground, semibold, themeable via --ddp-group-fg')


// The grip sits 12px below the wrapper's top edge and is only 56px wide. If the
// drag measured the grip's own rect, the wrapper would jump up 12px per drag and
// the right-edge clamp would be off by 504px. Measure the wrapper instead.
CANNED_TASKS = []
const idleForDrag = renderOverlay()
const grip = findByClass(idleForDrag, 'ddp-handle')[0]
if (!grip || typeof grip.props.onPointerDown !== 'function')
  throw new Error('the grip must carry the drag handler')

const WRAP_RECT = { left: 680, top: 76, width: 560, height: 12 }
const GRIP_RECT = { left: 932, top: 88, width: 56, height: 6 }
const wrapNode = { getBoundingClientRect: () => WRAP_RECT }
const gripNode = {
  getBoundingClientRect: () => GRIP_RECT,
  closest: (sel) => (sel === '.ddp-wrap' ? wrapNode : null),
}

grip.props.onPointerDown({ button: 0, clientX: 500, clientY: 300, currentTarget: gripNode })
for (const fn of listeners.pointermove || []) {
  fn({ clientX: 500, clientY: 340, cancelable: true, preventDefault() {} })
}
for (const fn of listeners.pointerup || []) fn({})

const dragged = JSON.parse(storage.get('dsh-download-progress:settings'))
console.log('\ndragged grip 40px down -> stored', JSON.stringify(dragged))
if (dragged.y !== 116)
  throw new Error('dragging the grip must move the wrapper by 40px (76+40=116), got ' + dragged.y)
// The drop position is converted to the centre as a percentage of the viewport
// (left 680 + width 560 / 2 = 960 of 1440 = 66.67%), so a later window resize
// keeps the card at the same relative spot.
if (dragged.x !== 66.67)
  throw new Error('drag must store the centre as a percentage (66.67), got ' + dragged.x)
console.log('  ok grip drag moves the wrapper (no 12px creep) and stores a percentage')

/* ---- the drop position renders as a percentage, so a resize keeps it ---- */
const afterDrag = renderOverlay()
const wrapAfterDrag = findByClass(afterDrag, 'ddp-wrap')[0]
if (!wrapAfterDrag) throw new Error('the overlay wrapper should still exist after a drag')
const dragStyle = wrapAfterDrag.props.style
console.log('\nafter drop: left =', dragStyle.left, '| transform =', dragStyle.transform)
if (dragStyle.left !== '66.67%')
  throw new Error('the stored percentage must drive left (66.67%), got ' + dragStyle.left)
if (dragStyle.transform !== 'translateX(-50%)')
  throw new Error('a percentage left must pair with translateX(-50%) so the CENTRE lands there')
console.log('  ok dropped position renders as a viewport percentage')

/* ---- the transform must NEVER flip, dragging or not ---- */
// `left` transitions over 180ms; `transform` does not. Switching the transform
// at the drop instant (none ⇄ translateX(-50%)) shifted the card half a width
// instantly while `left` was still easing — the "jumps left, then snaps back"
// flicker seen right after releasing the mouse. So `left` always names the
// CENTRE and the transform is constant, in every branch.
if (src.indexOf("position.transform = 'translateX(-50%)'") < 0)
  throw new Error('the wrapper must always be centred with translateX(-50%)')
if (/position\.transform\s*=\s*'none'/.test(src))
  throw new Error('the transform must not be reset to none while dragging: it flips on drop and jitters')
if (src.indexOf('position.left = drag.x + drag.half') < 0)
  throw new Error('a dragged card must place its CENTRE in pixels, i.e. drag.x + drag.half')
console.log('  ok drag and drop share one transform, so nothing shifts on release')

/* ---- no visible scrollbar: the track would take layout width ---- */
// Crossing the row cap would then narrow every card by the scrollbar width and
// re-wrap the log line mid-poll.
if (src.indexOf('scrollbar-width:none') < 0)
  throw new Error('the list must hide its scrollbar track (scrollbar-width:none)')
if (src.indexOf('::-webkit-scrollbar-thumb') >= 0)
  throw new Error('a scrollbar thumb rule means a visible track; the list must scroll without one')
console.log('  ok the list scrolls without reserving a scrollbar gutter')

/* ---- a live resize drops the backdrop blur (the expensive half) ---- */
if (!(listeners.resize || []).length)
  throw new Error('the overlay must listen for window resize: stale pixels + per-frame re-blur')
for (const fn of listeners.resize) fn({})
if (src.indexOf('.ddp-wrap--resizing .ddp-card') < 0)
  throw new Error('resize must switch the glass off: .ddp-wrap--resizing .ddp-card rule is missing')
console.log('  ok resize handler registered and drops the glass while resizing')

/* ---- normalisation drops unknown keys and clamps the row cap ---- */
const store = fakeWindow.localStorage
store.setItem('dsh-download-progress:settings', JSON.stringify({ maxVisible: 9, position: 'nope' }))
const reread = JSON.parse(store.getItem('dsh-download-progress:settings'))
console.log('\nnormalisation check: wrote', JSON.stringify(reread))

/* ---- dragging is wired, and "reset position" writes the default back ---- */
const list = findByClass(overlayTree, 'ddp-list')[0]
if (!list || typeof list.props.onPointerDown !== 'function')
  throw new Error('the list must carry the drag handler')
console.log('  ok drag handler attached to the list')

const resetButton = buttons[0].node
resetButton.props.onClick()
const afterReset = JSON.parse(store.getItem('dsh-download-progress:settings'))
console.log('  stored after reset =', JSON.stringify(afterReset))
if (afterReset.x !== null || afterReset.y !== 76)
  throw new Error('reset must store x:null y:76, got ' + JSON.stringify(afterReset))
if (Object.prototype.hasOwnProperty.call(afterReset, 'position'))
  throw new Error('the obsolete position key must not be written')
if (store.getItem('dsh-download-progress:settings').indexOf('preview') >= 0)
  throw new Error('sample/peek state must never be persisted')
console.log('  ok reset position + no peek state persisted')

/* ---- inline bar: the compact presenter in the composer tool row ---- */
// Registered into a LIST slot that other plugins also fill, so the two things
// that must hold are (a) it never grows and pushes a neighbour off, and (b) it
// only ever paints this conversation's own work — an idle session shows the
// resting dots, never another session's numbers.
console.log('\n---- inline bar ----')
const inlineSlot = registrations.find((r) => r.spec.name === 'conversation.input.left')
if (!inlineSlot) throw new Error('the composer tool row registration is missing')
if (inlineSlot.spec.order <= 4)
  throw new Error('the bar must order behind the chips already in the row, got ' + inlineSlot.spec.order)
console.log('  ok registered into conversation.input.left at order', inlineSlot.spec.order)

function renderInline(props) {
  return inlineSlot.component(Object.assign({ sessionId: TEST_SESSION }, props))
}

// Default display is the overlay, so the bar stays out of the row entirely.
CANNED_TASKS = CANNED_TASKS_BASE
if (renderInline() !== null)
  throw new Error('with display = overlay the inline bar must not paint anything')
console.log('  ok display = overlay -> no chip in the tool row')

// Nothing of THIS session in flight: the chip stays as the resting dots — that
// is what the ring collapses into — but it must never borrow a neighbour's
// numbers to fill the shape.
displaySelect.node.props.onChange({ target: { value: 'inline' } })
const restTree = renderInline({ sessionId: 'some-other-session' })
if (!restTree) throw new Error('an idle session still owns the resting chip')
if (String(restTree.props.className) !== 'ddp-mx ddp-mx--dots')
  throw new Error('idle must paint the three dots, got ' + restTree.props.className)
const restText = []
walk(restTree, 0, restText)
const restFlat = restText.map(String).join(' ')
if (/MB|KB|%/.test(restFlat))
  throw new Error("the idle chip must not borrow another session's numbers: " + restFlat)
if (renderInline({ sessionId: '' }) !== null)
  throw new Error('with no session id the bar must not guess: it renders nothing')
console.log('  ok other session -> resting dots, no session -> nothing')

// One real download with a known total: the bar body + rate. The name, the log
// and the byte counters stay out — this is the compact presenter.
CANNED_TASKS = [
  { id: 'one', kind: 'download', sessionId: TEST_SESSION, label: 'big.iso', bytes: 2500000, total: 5000000, speed: 1258291, elapsedMs: 4000 },
]
const inlineTree = renderInline()
if (!inlineTree) throw new Error('a download in this session must paint the chip')
const inlineClass = String(inlineTree.props.className)
const mxText = []
walk(inlineTree, 0, mxText)
console.log('  chip text =', JSON.stringify(mxText.map(String)))
if (inlineClass !== 'ddp-mx ddp-mx--bar')
  throw new Error('a known fraction must pick the bar body, got ' + inlineClass)
// The hover bubble is part of the chip's tree, so the "at a glance" readout is
// everything except the percentage that only appears on hover.
const glance = mxText.filter((t) => String(t).indexOf('%') < 0)
if (glance.join('') !== '1.20 MB/s')
  throw new Error('the compact bar shows the rate and nothing else, got ' + JSON.stringify(mxText))
// The fraction now lives on the progress path's dash array: 50% of the 59-unit
// straight run. The rounded caps add the last 5px visually.
const prog = findByClass(inlineTree, 'ddp-mx-prog')[0]
if (!prog) throw new Error('the bar needs a progress path')
if ((prog.props.style || {}).strokeDasharray !== '29.50 200')
  throw new Error('the progress path must carry the real fraction, got ' + JSON.stringify(prog.props.style))
const mxTip = findByClass(inlineTree, 'ddp-mx-tip')[0]
if (!mxTip || mxTip.props.children !== '50.0%')
  throw new Error('hovering the bar must reveal the percentage')
if (findByClass(inlineTree, 'ddp-mx-log').length || findByClass(inlineTree, 'ddp-mx-name').length)
  throw new Error('the compact chip must not print the name or the log line')
// Both shapes are one clipped viewBox with two stroked paths, so the ring can
// unroll into the bar instead of two elements cross-fading.
for (const body of ['ddp-mx-shape', 'ddp-mx-arc', 'ddp-mx-prog', 'ddp-mx-dots'])
  if (!findByClass(inlineTree, body).length)
    throw new Error('the ' + body + ' body must stay mounted for the morph')
// The browser's own tooltip duplicated our hover bubble, painted in system
// chrome and faded on its own schedule. The aria values carry the number.
if ('title' in (inlineTree.props || {}))
  throw new Error('the chip must not carry a native title tooltip')
console.log('  ok determinate = bar(50%) + rate + hover tip, no detail rows, all bodies mounted')

// Choosing the simple bar as the ONLY presenter must retire the floating stack,
// which is the whole point of the option.
CANNED_TASKS = CANNED_TASKS_BASE
if (renderOverlay() !== null)
  throw new Error('display = inline must leave the floating overlay unpainted')
console.log('  ok display = inline -> overlay renders nothing')

// No fraction but a known kind: the ring carries the motion, and the wording
// moves into the hover bubble (a 22px row has no room for it).
CANNED_TASKS = [
  { id: 's', kind: 'search', sessionId: TEST_SESSION, label: 'dsh 插件', elapsedMs: 900 },
]
const searchTree = renderInline()
const searchText = []
walk(searchTree, 0, searchText)
console.log('  search chip =', JSON.stringify(searchText.map(String)))
if (String(searchTree.props.className) !== 'ddp-mx ddp-mx--ring')
  throw new Error('a search has no fraction, so it must pick the ring body')
const searchTip = findByClass(searchTree, 'ddp-mx-tip')[0]
if (!searchTip || String(searchTip.props.children).indexOf('搜索中') !== 0)
  throw new Error('the ring must spell the kind of work out on hover, got ' + JSON.stringify(searchTip && searchTip.props.children))
// Everything the walk found except the hover bubble: the ring paints no words.
const searchGlance = searchText.filter((t) => String(t) !== String(searchTip.props.children))
if (searchGlance.join('') !== '')
  throw new Error('the ring body carries no text of its own, got ' + JSON.stringify(searchGlance.map(String)))
if ((findByClass(searchTree, 'ddp-mx-prog')[0].props.style || {}).strokeDasharray !== '9 24')
  throw new Error('without a total the ring shows its short spinning arc, not a fraction')

CANNED_TASKS = [{ id: 'f', kind: 'fetch', sessionId: TEST_SESSION, elapsedMs: 5200 }]
const fetchTip = findByClass(renderInline(), 'ddp-mx-tip')[0]
if (String(fetchTip.props.children).indexOf('抓取中') !== 0)
  throw new Error('a page fetch must read 抓取中 on hover, got ' + JSON.stringify(fetchTip.props.children))
CANNED_TASKS = [{ id: 'i', kind: 'install', sessionId: TEST_SESSION, elapsedMs: 9000 }]
const installTip = findByClass(renderInline(), 'ddp-mx-tip')[0]
if (String(installTip.props.children).indexOf('安装中') !== 0)
  throw new Error('an install must read 安装中 on hover')
CANNED_TASKS = [
  { id: 'u', kind: 'download', sessionId: TEST_SESSION, unresolved: true, bytes: 3000000, speed: 524288, elapsedMs: 7000 },
]
const unresolvedTip = findByClass(renderInline(), 'ddp-mx-tip')[0]
if (String(unresolvedTip.props.children).indexOf('下载中') !== 0)
  throw new Error('a download with no total is a ring, not a bar')
if (String(unresolvedTip.props.children).indexOf('2.86 MB') < 0)
  throw new Error('the ring detail must still report how much landed, got ' + JSON.stringify(unresolvedTip.props.children))
console.log('  ok indeterminate = ring body, wording moved into the hover tip')

// Zero measured bytes and zero speed is "preparing", not "0 B / 7 GiB · 0 B/s".
// aria2c spends this window preallocating the file and its bitmap does not exist
// yet, so the host withholds the size on purpose; the card must say so instead of
// painting a 0% bar that looks like a stall.
CANNED_TASKS = [
  { id: 'p', kind: 'download', sessionId: TEST_SESSION, label: 'win11.iso', bytes: 0, total: 7774558208, speed: 0, elapsedMs: 4000 },
]
const preparingTip = findByClass(renderInline(), 'ddp-mx-tip')[0]
if (String(preparingTip.props.children).indexOf('准备中') < 0)
  throw new Error('a download with no byte counted yet must read 准备中, got ' + JSON.stringify(preparingTip.props.children))
CANNED_TASKS = [
  { id: 'p2', kind: 'download', sessionId: TEST_SESSION, label: 'win11.iso', bytes: 0, total: 7774558208, speed: 0, elapsedMs: 4000, done: true },
]
const bgPreparingTip = findByClass(renderInline(), 'ddp-mx-tip')[0]
if (String(bgPreparingTip.props.children).indexOf('准备中') < 0)
  throw new Error('a background download is done:true from its first tick and must still read 准备中, got ' + JSON.stringify(bgPreparingTip.props.children))
CANNED_TASKS = [
  { id: 'p3', kind: 'download', sessionId: TEST_SESSION, label: 'win11.iso', bytes: 7774558208, total: 7774558208, speed: 0, elapsedMs: 60000, done: true },
]
const finishedTip = findByClass(renderInline(), 'ddp-mx-tip')[0]
if (String(finishedTip.props.children).indexOf('准备中') >= 0)
  throw new Error('a finished task has bytes and is never preparing, got ' + JSON.stringify(finishedTip.props.children))
console.log('  ok zero bytes and no speed = 准备中 (background done:true included)')

// Nothing at all: not even the kind of work. Three breathing dots, no words.
CANNED_TASKS = [{ id: 'x', sessionId: TEST_SESSION }]
const dotsTree = renderInline()
if (String(dotsTree.props.className) !== 'ddp-mx ddp-mx--dots')
  throw new Error('with no kind at all the chip must fall back to the dots body')
const dotsText = []
walk(dotsTree, 0, dotsText)
const dotsTip = findByClass(dotsTree, 'ddp-mx-tip')[0]
if (!dotsTip || dotsTip.props.children !== '处理中')
  throw new Error('the dots must still answer a hover')
const dotsGlance = dotsText.filter((t) => String(t) !== '处理中')
if (dotsGlance.join('') !== '')
  throw new Error('the dots body carries no text of its own, got ' + JSON.stringify(dotsGlance.map(String)))
if (findByClass(dotsTree, 'ddp-mx-dots')[0].props.children.length !== 3)
  throw new Error('the dots body is exactly three dots')
console.log('  ok no state at all = three dots + hover tip')

// Several calls in one session: the chip tracks one and counts the rest.
CANNED_TASKS = [
  { id: 'q1', kind: 'download', sessionId: TEST_SESSION, bytes: 1000000, total: 2000000, speed: 524288 },
  { id: 'q2', kind: 'download', sessionId: TEST_SESSION, bytes: 100, total: 200, speed: 262144 },
  { id: 'q3', kind: 'download', sessionId: TEST_SESSION, bytes: 100, total: 200, speed: 262144 },
]
const multiText = []
walk(renderInline(), 0, multiText)
console.log('  multi chip =', JSON.stringify(multiText.map(String)))
if (multiText.indexOf('+2') < 0) throw new Error('a session with 3 calls must say how many follow')
if (findByClass(renderInline(), 'ddp-mx-prog')[0].props.style.strokeDasharray !== '29.50 200')
  throw new Error('the bar must track this session\'s own oldest task, not another session\'s')

// Speed is a setting here too, and the theme reaches the chip through the same
// token registry the overlay uses.
CANNED_TASKS = CANNED_TASKS_BASE
const speedToggle = checkboxes.find((c) => c.node.props['aria-label'] === '显示下载速度')
speedToggle.node.props.onChange({ target: { checked: false } })
const noSpeedText = []
walk(renderInline(), 0, noSpeedText)
console.log('  speed off chip =', JSON.stringify(noSpeedText.map(String)))
if (noSpeedText.some((t) => String(t).indexOf('/s') >= 0))
  throw new Error('with speed off the chip must not print a rate, got ' + JSON.stringify(noSpeedText.map(String)))
speedToggle.node.props.onChange({ target: { checked: true } })
const themeDrop = selects.find((c) => c.node.props['aria-label'] === '主题')
themeDrop.node.props.onChange({ target: { value: 'light' } })
const themed = renderInline()
if (!themed || !themed.props.style || themed.props.style['--ddp-fg'] !== '#1b1b1f')
  throw new Error('the inline bar must take its look from the same theme tokens as the overlay')
console.log('  ok theme tokens reach the chip; speed setting respected')

// The morph is only real if both states declare the same command list, because
// that is the precondition Chromium puts on interpolating d. These assertions
// exist so a later edit cannot quietly turn the morph back into a cross-fade.
const cssBlock = src.slice(src.indexOf('.ddp-mx{'), src.indexOf('/* ---- settings page ---- */'))
const ringD = (cssBlock.match(/d:path\("([^"]+)"\)/g) || []).map((m) => m.slice(m.indexOf('"') + 1, -2))
if (ringD.length < 2)
  throw new Error('both the ring and the bar state must declare a d, or the shape cannot interpolate')
const cmds = (d) => (d.match(/[A-Za-z]/g) || []).join('')
if (cmds(ringD[0]) !== cmds(ringD[1]))
  throw new Error('the two d values must share a command list: ' + cmds(ringD[0]) + ' vs ' + cmds(ringD[1]))
if (cmds(ringD[0]) !== 'MCCCC')
  throw new Error('expected M plus four C segments, got ' + cmds(ringD[0]))
if (cssBlock.indexOf('.ddp-mx-fill') >= 0)
  throw new Error('the fill span is gone; the shape is drawn as SVG paths now')
if (/\.ddp-mx:hover\{[^}]*transform:/.test(cssBlock))
  throw new Error('hover must not translate the chip: it makes the readout flicker on the edge')
if (cssBlock.indexOf('border:0') < 0)
  throw new Error('the capsule must be borderless so the morph reads as one shape')
console.log('  ok one path morphs ring -> bar (M+4C in both states), borderless capsule')
themeDrop.node.props.onChange({ target: { value: 'auto' } })
displaySelect.node.props.onChange({ target: { value: 'overlay' } })
/* ---- background work: a flat row, and two honest state words ---- */
// A background job has no fraction. Drawing a track for it would read as a
// stalled transfer, so the row is a line with a state word instead. `waiting`
// is the word that earns the feature: it says the agent's current call is
// blocked on this row, which "running" deliberately does not.
CANNED_TASKS = []
CANNED_BACKGROUND = [
  { id: 'bg1', type: 'bash', label: 'npm test', status: 'running', elapsedMs: 42000, sessionId: TEST_SESSION },
  { id: 'bg2', type: 'subagent', label: '市场调研', status: 'running', waiting: true, elapsedMs: 9000, sessionId: TEST_SESSION },
]
// Debug mode paints five sample cards regardless of the wire, and an earlier
// block leaves it on. Turn it off so the card count below measures the rows and
// nothing else; it is restored right after.
debugToggle.node.props.onChange({ target: { checked: false } })
const bgTree = renderOverlay()
const bgRows = findByClass(bgTree, 'ddp-bgrow')
if (bgRows.length !== 2) throw new Error('two background rows must render, got ' + bgRows.length)
const waitingRows = bgRows.filter((r) => /ddp-bgrow--waiting/.test(r.props.className))
if (waitingRows.length !== 1)
  throw new Error('exactly the blocked row carries --waiting, got ' + waitingRows.length)
const bgCards = findByClass(bgTree, 'ddp-card')
if (bgCards.length !== 0)
  throw new Error(
    'background work must not borrow the transfer card: a card promises a fill, got ' + bgCards.length,
  )
const bgText = []
walk(bgTree, 0, bgText)
if (bgText.indexOf('后台任务') < 0) throw new Error('the block needs its heading')
if (bgText.indexOf('等待中') < 0 || bgText.indexOf('运行中') < 0)
  throw new Error('the two states must read differently, got ' + JSON.stringify(bgText.map(String)))
if (bgTree.props.style['--ddp-bg'] === '0px')
  throw new Error('the wrapper must reserve height for the background rows')
console.log('  ok background: flat rows, waiting vs running, own height allowance')

// The chip: a transfer outranks background work, and when nothing transfers the
// chip is exactly where "the agent is waiting on something" belongs. An earlier
// block parks the display mode on overlay, so bring the composer bar back.
displaySelect.node.props.onChange({ target: { value: 'both' } })
const bgInline = renderInline()
const bgInlineText = []
walk(bgInline, 0, bgInlineText)
console.log('  background chip =', JSON.stringify(bgInlineText.map(String)))
if (bgInlineText.join(' ').indexOf('等待后台任务') < 0)
  throw new Error('a blocked background row must claim the chip when nothing transfers')
displaySelect.node.props.onChange({ target: { value: 'overlay' } })
CANNED_BACKGROUND = []

console.log('\nSMOKE OK — bundle loads,', Object.keys(injectors).length, 'slots register, settings page renders', texts.length, 'text nodes')


/* ---- overlay: 准备中 before the first real byte ---- */
// The overlay is what the user actually watches, and it goes through describe()
// rather than briefOf(). A download with no measured byte must print 准备中 there
// too — including the background case, whose task is done:true from tick one.
// Placed last: an extra render here cannot disturb the debug-mode effect above.
CANNED_TASKS = [
  { id: 'p', kind: 'download', sessionId: TEST_SESSION, label: 'CentOS-Stream-10.iso', bytes: 0, total: 10801774592, speed: 0, elapsedMs: 40000, done: true },
]
const preparingTexts = []
walk(renderOverlay(), 0, preparingTexts)
if (!preparingTexts.some((t) => String(t).indexOf('准备中') >= 0))
  throw new Error('the overlay must say 准备中 before the first real byte, got ' + JSON.stringify(preparingTexts.map(String)))
console.log('\n  ok overlay says 准备中 before the first real byte')
CANNED_TASKS = CANNED_TASKS_BASE
