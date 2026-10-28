
    import Module from 'node:module'
    import http from 'node:http'
    import https from 'node:https'
    delete Module.registerHooks
    for (const mod of [http, https]) {
      for (const key of ['request', 'get']) {
        Object.defineProperty(mod, key, { value: mod[key], writable: false, configurable: false })
      }
    }
    const { apply } = await import("file:///D:/AIworks/dsh-download-progress/index.js")
    const routes = []
    apply({
      effect: (fn) => { try { fn() } catch {} ; return () => {} },
      on: () => {},
      get: () => undefined,
      webServer: { register: (r) => (routes.push(r), () => {}) },
    })
    const cfg = routes.find((r) => r.path === '/download-progress/config')
    const hs = {}
    cfg.handler({ on: (n, f) => (hs[n] = f) }, { writeHead() {}, end() {} })
    hs.data?.(JSON.stringify({ depthProgress: true }))
    hs.end?.()
    const state = routes.find((r) => r.path === '/download-progress/state')
    let body = null
    state.handler({ method: 'GET', headers: {} }, { writeHead() {}, end: (p) => { body = JSON.parse(p) } })
    process.stdout.write(JSON.stringify({ caps: body.capabilities, stream: body.stream }))
    process.exit(0)
  