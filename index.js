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
import {
  beginTask,
  noteInstallLog,
  noteInstallPhase,
  setTitleResolver,
  snapshot,
  sweep,
} from './state.js'
import { text } from './utils.js'

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
 * Build the Host-side "what is this session called" lookup.
 *
 * Two services are involved and both are optional: `sessions` turns the id on
 * the dispatch into a live `Session`, and `sessionTitle` folds that session's
 * log into the name the sidebar shows. Neither is guaranteed to exist on an
 * older host, so every step degrades to '' and the client falls back to a short
 * id label instead of showing an unlabelled block.
 *
 * The lookup is deliberately lazy (called once per task per snapshot, not once
 * per dispatch): DSH generates a session title asynchronously from the first
 * prompt, so a download started in the opening seconds of a brand-new session
 * has no title when the task is registered.
 *
 * @param {{get: (name: string) => any}} ctx
 * @returns {(sessionId: string) => string}
 */
function makeTitleResolver(ctx) {
  return (sessionId) => {
    try {
      const sessions = ctx.get('sessions')
      const titles = ctx.get('sessionTitle')
      if (!sessions || !titles || !sessionId) return ''
      const session = sessions.get(sessionId)
      if (!session) return ''
      const snapshot = titles.get(session)
      return snapshot && snapshot.title ? text(snapshot.title) : ''
    } catch {
      /* an older host, or a session that was torn down mid-download */
      return ''
    }
  }
}

/**
 * @param {{effect: Function, on: Function, get: Function, webServer: {register: Function}}} ctx
 */
export function apply(ctx) {
  // Session names for the per-session grouping on the overlay. Cleared on
  // disposal so a disabled plugin cannot hold a reference to the host services.
  ctx.effect(() => {
    setTitleResolver(makeTitleResolver(ctx))
    return () => setTitleResolver(null)
  })

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
  //
  // Every step that could throw — classifying, resolving the cwd, registering the
  // task — is wrapped, and each failure path still calls `next()`. A bookkeeping
  // plugin that can break the tool call it is only supposed to watch would be a
  // worse bug than never showing a bar at all.
  ctx.on('tools/execute', async (exec, next) => {
    let task = null
    try {
      const plan = classify(exec)
      if (!plan) return await next()
      task = beginTask(exec, plan, await resolveCwd(ctx, exec))
    } catch {
      return next()
    }

    try {
      return await next()
    } finally {
      // The tool returned, but the task stays on screen until its file stops
      // growing — see sweep(). That is what keeps background downloads visible.
      // A failure here must not mask the tool's own result or error.
      try {
        task.done = true
      } catch {
        /* the task object is ours; this cannot fail in practice */
      }
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
