import assert from 'node:assert/strict'

// Load the real Host entry the way the Host does: import the package's main file.
// A broken import graph or a syntax error fails right here, before any device
// ever sees the plugin.
const mod = await import('./index.js')
console.log('import ok; exports=' + Object.keys(mod).join(','))

assert.equal(typeof mod.apply, 'function', 'apply must be a function')
assert.deepEqual(mod.inject, ['webServer'], 'inject must declare webServer')

// A ctx that records what the plugin asks for and hands back inert stubs.
const registered = []
const listeners = []
const effects = []
const ctx = {
  effect: (fn) => { effects.push(fn()); return () => {} },
  on: (name, fn) => { listeners.push(name) },
  get: (name) => (name === 'workingDirectory' ? { cwd: () => process.cwd() } : undefined),
  webServer: {
    register: (route) => { registered.push(route); return () => {} },
  },
}

mod.apply(ctx)

console.log('routes registered=' + registered.length + ' path=' + registered[0]?.path + ' kind=' + registered[0]?.kind)
assert.equal(registered.length, 1, 'exactly one route')
assert.equal(registered[0].path, '/download-progress/state')
assert.equal(registered[0].kind, 'exact')
console.log('events subscribed=' + new Set(listeners).size + ' :: ' + [...new Set(listeners)].join(','))

// Drive the handler the way the web server does and read the body back.
const route = registered[0]
const body = await new Promise((resolve, reject) => {
  const res = {
    headers: null,
    writeHead(code, headers) { this.code = code; this.headers = headers; return this },
    end(payload) { resolve({ code: this.code, headers: this.headers, payload }) },
    on() {},
  }
  try { route.handler({ method: 'GET', url: route.path, headers: {} }, res) } catch (error) { reject(error) }
})

const parsed = JSON.parse(body.payload)
console.log('status=' + body.code + ' content-type=' + body.headers['content-type'] + ' cache-control=' + body.headers['cache-control'])
console.log('schemaVersion=' + parsed.schemaVersion + ' tasks=' + parsed.tasks.length + ' background=' + parsed.background.length)
assert.equal(body.code, 200)
assert.equal(body.headers['cache-control'], 'no-store')
assert.ok(Number.isInteger(parsed.schemaVersion), 'schemaVersion must be an integer')
assert.ok(Array.isArray(parsed.tasks) && Array.isArray(parsed.background))

// Effects must be safe to run and to dispose.
console.log('effects started=' + effects.length + ' listeners=' + listeners.length)
console.log('HOST BOOT OK — apply wires one route, the handler answers 200, effects settle')
// apply() starts the sampler timer; nothing else keeps the loop alive.
process.exit(0)