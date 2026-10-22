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
let CANNED_TASKS = [
  { id: 'a', kind: 'download', label: 'node-v20.11.0-win-x64.zip', bytes: 12345678, total: 29701389, speed: 5242880, elapsedMs: 3400 },
  { id: 'b', kind: 'install', phase: 'installing', log: 'Progress: resolved 42, reused 40', elapsedMs: 9000 },
  { id: 'c', kind: 'fetch', elapsedMs: 5200 },
  { id: 'd', kind: 'search', label: 'dsh 插件开发文档', elapsedMs: 1200 },
  { id: 'e', kind: 'download', unresolved: true, elapsedMs: 7000 },
]

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
    // The only list-state in the plugin is the fetched task list.
    if (Array.isArray(value) && value.length === 0) return [CANNED_TASKS, () => {}]
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
  const tree = component({ close: () => {} })
  if (tree === undefined) throw new Error(spec.name + ': component returned undefined')
  if (tree === null) throw new Error(spec.name + ': component rendered nothing (null)')
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
if (checkboxes.length !== 3) throw new Error('expected 3 checkboxes, got ' + checkboxes.length)
if (selects.length !== 4) throw new Error('expected 4 selects, got ' + selects.length)
if (buttons.length !== 1) throw new Error('expected the reset-position button')
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
if (!debugToggle) throw new Error('settings page is missing the debug-mode toggle')
if (debugToggle.node.props.checked !== false)
  throw new Error('debug mode must default to off so samples cannot be mistaken for real downloads')

const easeSelect = selects.find((c) => c.node.props['aria-label'] === '出现动画')
if (!easeSelect) throw new Error('settings page is missing the enter-animation dropdown')
if (easeSelect.options !== 4)
  throw new Error('enter-animation dropdown should list 4 feels, got ' + easeSelect.options)

/* ---- debug mode off: no real tasks means the overlay renders nothing ---- */
CANNED_TASKS = []
const overlaySlot = registrations.find((r) => r.spec.name === 'shell.overlay')

const hookCounts = []
function renderOverlay() {
  React.__hooks = 0
  const tree = overlaySlot.component({ close: () => {} })
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
easeSelect.node.props.onChange({ target: { value: 'float' } })
console.log('  ok enter animation = ddp-ease-<id> per card, staggered, never on the list')

/* ---- theme: the wrapper carries --ddp-* overrides, auto carries none ---- */
const autoStyle = idleTree.props.style || {}
console.log('\ntheme auto overrides:', Object.keys(autoStyle).filter((k) => k.indexOf('--ddp-') === 0 && k !== '--ddp-rows').length)
if (Object.keys(autoStyle).some((k) => k.indexOf('--ddp-') === 0 && k !== '--ddp-rows'))
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
if (Object.keys(backToAuto).some((k) => k.indexOf('--ddp-') === 0 && k !== '--ddp-rows'))
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
for (const needle of ['node-v20.11.0-win-x64.zip', '插件安装中...下载中...', '正在抓取网页中...', '正在搜索「下载进度条 插件开发」中...请稍后', '载入中...']) {
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

/* ---- dragging the grip must move the wrapper, not the grip ---- */
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

console.log('\nSMOKE OK — bundle loads, both slots register, settings page renders', texts.length, 'text nodes')

