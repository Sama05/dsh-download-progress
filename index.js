/**
 * dsh-download-progress — Host half.
 *
 * Observes tool dispatch through the official `tools/execute` waterfall and
 * publishes a compact JSON snapshot that the Client half polls once per second.
 * It never changes a dispatch decision: every path returns `next()`.
 *
 * Layout of the Host half:
 *   utils.js    pure string/path helpers
 *   detect.js   "is this call a download / install / fetch / search?"
 *   state.js    task bookkeeping, the 1 s sampler, the snapshot shape
 *   index.js    wiring only (events, route, plugin export)  ← this file
 */
import { classify } from './detect.js'
import { beginTask, noteInstallLog, noteInstallPhase, snapshot, sweep } from './state.js'

/** Where the Client half polls. Served by the host's own web server. */
const ROUTE_PATH = '/download-progress/state'

/** Sampling period. Matches the client's poll rate so no byte growth is missed. */
const TICK_MS = 1000

export const inject = ['webServer']

/**
 * Working directory of the calling agent, so relative output paths can be made
 * absolute. A host without `workingDirectory` (or a call outside any agent) just
 * yields '' and relative paths resolve against the host process instead.
 *
 * @param {{get: (name: string) => any}} ctx
 * @param {{agent?: unknown}} exec
 * @returns {Promise<string>}
 */
async function resolveCwd(ctx, exec) {
  try {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory && exec?.agent) return await workingDirectory.ensure(exec.agent)
  } catch {
    /* older host, or the agent has no directory yet */
  }
  return ''
}

/**
 * @param {{effect: Function, on: Function, get: Function, webServer: {register: Function}}} ctx
 */
export function apply(ctx) {
  // The sampler. Wrapped in ctx.effect so disabling the plugin stops the timer.
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        sweep(Date.now())
      } catch {
        /* never let one bad sample throw into the host loop */
      }
    }, TICK_MS)
    return () => clearInterval(timer)
  })

  // Around-dispatch observation. This listener owns no decision: it either does
  // not recognise the call and hands it straight back, or it records a task and
  // still hands it back unchanged.
  ctx.on('tools/execute', async (exec, next) => {
    let plan = null
    try {
      plan = classify(exec)
    } catch {
      plan = null
    }
    if (!plan) return next()

    const task = beginTask(exec, plan, await resolveCwd(ctx, exec))
    try {
      return await next()
    } finally {
      // The tool returned, but the task stays on screen until its file stops
      // growing — see sweep(). That is what keeps background downloads visible.
      task.done = true
    }
  })

  // Plugin installs: pnpm streams log chunks and phase changes, no byte counts.
  ctx.on('plugin-manager/install-log', noteInstallLog)
  ctx.on('plugin-manager/install-state', noteInstallPhase)

  // The snapshot route the Client half polls. `no-store` because the body is
  // meaningless one second later.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (_req, res) => {
        let body
        try {
          body = JSON.stringify({ tasks: snapshot() })
        } catch {
          // A task with a circular reference would be a bug, but the overlay
          // must never blank out because of it.
          body = '{"tasks":[]}'
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    }),
  )
}
