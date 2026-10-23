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
  BUILD_TAG,
  beginTask,
  noteInstallLog,
  noteInstallPhase,
  setTitleResolver,
  snapshot,
  sweep,
} from './state.js'
import {
  backgroundSnapshot,
  noteJobEvent,
  noteSubagentEnd,
  noteSubagentStart,
  noteToolEnd,
  noteToolStart,
  noteWorkflowEnd,
  noteWorkflowLog,
  noteWorkflowPhase,
  noteWorkflowStart,
  reconcileJobs,
  setTitleLookup,
} from './background.js'
import { text } from './utils.js'

/** Where the Client half polls. Served by the host's own web server. */
const ROUTE_PATH = '/download-progress/state'

/** Sampling period. Matches the client's poll rate so no byte growth is missed. */
const TICK_MS = 1000

/**
 * Wire contract version for the snapshot body.
 *
 * Bump this when a field is REMOVED or its meaning changes. Adding a field is
 * not a bump: the Client half ignores what it does not read, so a new field
 * ships without touching the UI. See CONTRACT.md for the field table and for
 * the rule about who is allowed to read which field.
 */
const SCHEMA_VERSION = 1

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
    const resolve = makeTitleResolver(ctx)
    setTitleResolver(resolve)
    // The background rows label themselves with the same names, so they share
    // one lookup instead of building a second, subtly different one.
    setTitleLookup(resolve)
    return () => {
      setTitleResolver(null)
      setTitleLookup(() => '')
    }
  })

  // The sampler. Wrapped in ctx.effect so disabling the plugin stops the timer.
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        const at = Date.now()
        // A row replayed from before its job settled never gets the matching
        // `settled`, and running rows never linger out — re-read the registry
        // so a ghost cannot outlive the work it describes.
        reconcileJobs(ctx.get('jobs'), at)
        // A job that is still running keeps its own session's cards alive past
        // the tool call that launched it — see sweep().
        const busy = new Set(
          backgroundSnapshot(at)
            .filter((row) => row.status === 'running')
            .map((row) => String(row.sessionId || '')),
        )
        sweep(at, (sessionId) => busy.has(String(sessionId || '')))
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
  //
  // The tool call is ALSO recorded even when it is not a transfer. That record is
  // what lets a background row say "the agent is blocked on me" instead of the
  // weaker "something is running": the handler is suspended for exactly as long
  // as the tool is, so `activeTools` is a truthful picture of who is stuck where.
  ctx.on('tools/execute', async (exec, next) => {
    const sessionId = String(exec?.agent?.id || '')
    let task = null
    try {
      noteToolStart(sessionId, exec?.name, exec?.arguments)
      const plan = classify(exec)
      if (plan) task = beginTask(exec, plan, await resolveCwd(ctx, exec))
    } catch {
      /* bookkeeping only: a throw here must not fail the observed tool call */
    }

    try {
      return await next()
    } finally {
      // The tool returned, but the task stays on screen until its file stops
      // growing — see sweep(). That is what keeps background downloads visible.
      // A failure here must not mask the tool's own result or error.
      try {
        if (task) task.done = true
      } catch {
        /* the task object is ours; this cannot fail in practice */
      }
      try {
        noteToolEnd(sessionId)
      } catch {
        /* same: bookkeeping only */
      }
    }
  })

  // Plugin installs: pnpm streams log chunks and phase changes, no byte counts.
  ctx.on('plugin-manager/install-log', noteInstallLog)
  ctx.on('plugin-manager/install-state', noteInstallPhase)

  /* ---- background work: jobs, subagents, workflows ---- */

  // Bash background jobs. `owners: 'all'` is the only filter that spans
  // sessions; a per-owner subscription would need to know every session id in
  // advance and would miss the first job of a session created later.
  //
  // The service is optional: a host without the jobs plugin simply has no
  // background rows, which must not stop the plugin from loading.
  ctx.effect(() => {
    const jobs = ctx.get('jobs')
    if (!jobs || !jobs.events || typeof jobs.events.subscribe !== 'function') {
      return undefined
    }
    let dispose = null
    let verify = null
    try {
      dispose = jobs.events.subscribe({ owners: 'all' }, noteJobEvent)
      // A replay can hand us rows that settled while nobody was subscribed
      // (the plugin was reloaded mid-download). Those never receive a later
      // `settled`, so verify them once instead of waiting out the quiet window.
      verify = setTimeout(() => {
        try {
          reconcileJobs(jobs, Date.now(), true)
        } catch {
          /* reconciliation is best-effort */
        }
      }, 1000)
    } catch {
      return undefined
    }
    return () => {
      try {
        if (verify) clearTimeout(verify)
      } catch {
        /* the timer may already have fired */
      }
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* the service may already be gone */
      }
    }
  })

  // Subagents and workflows. Both are emitted process-wide; ownership is
  // inferred in background.js from the tool the parent is blocked in.
  ctx.on('subagent/start', noteSubagentStart)
  ctx.on('subagent/end', noteSubagentEnd)
  ctx.on('workflow/start', noteWorkflowStart)
  ctx.on('workflow/phase', noteWorkflowPhase)
  ctx.on('workflow/log', noteWorkflowLog)
  ctx.on('workflow/end', noteWorkflowEnd)

  // The snapshot route the Client half polls. `no-store` because the body is
  // meaningless one second later.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (_req, res) => {
        let body
        try {
          body = JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            buildTag: BUILD_TAG,
            tasks: snapshot(),
            background: backgroundSnapshot(),
          })
        } catch {
          // A task with a circular reference would be a bug, but the overlay
          // must never blank out because of it.
          body = JSON.stringify({ schemaVersion: SCHEMA_VERSION, tasks: [], background: [] })
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
