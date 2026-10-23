/**
 * background/snapshot.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
import { activeTools, flows, jobs, subs, title } from './tables.js'
import { jobStatus } from './jobs.js'
import { isForegroundJob, isWaitedOn } from './waits.js'
import { LINGER_MS, MAX_ROWS, RECONCILE_AFTER_MS } from './tuning.js'

/* ------------------------------------------------------------------ *
 * snapshot
 * ------------------------------------------------------------------ */

/**
 * The background half of the wire body.
 *
 * Rows are ordered waiting-first, then newest first, so the row a user cares
 * about ("the agent is stuck on this") is the one at the top of a short list.
 *
 * @param {number} now
 * @returns {object[]}
 */
export function backgroundSnapshot(now = Date.now()) {
  const rows = []
  for (const row of [...jobs.values(), ...subs.values(), ...flows.values()]) {
    // Drop settled rows once they have lingered long enough to be noticed.
    if (row.status !== 'running' && row.status !== 'stopping') {
      if (now - (row.finishedAt || row.seenAt || 0) > LINGER_MS) continue
    }
    // A foreground command is already in the transcript; listing it here would
    // double-report it and claim "the agent is waiting" for a plain tool call.
    if (isForegroundJob(row)) continue
    const sessionId = String(row.sessionId || '')
    rows.push({
      id: row.id,
      type: row.type,
      label: row.label,
      detail: row.detail,
      sessionId,
      sessionTitle: sessionId ? title(sessionId) : '',
      status: row.status,
      waiting: isWaitedOn(row),
      startedAt: row.startedAt,
      elapsedMs: Math.max(0, now - row.startedAt),
    })
  }

  rows.sort((a, b) => {
    if (a.waiting !== b.waiting) return a.waiting ? -1 : 1
    return b.startedAt - a.startedAt
  })
  return rows.slice(0, MAX_ROWS)
}

/**
 * Re-verify running rows against the authoritative registry.
 *
 * The event stream is an incremental feed, not a snapshot: subscribing after a
 * job already settled can replay the `registered` view (status `running`) with
 * no later `settled` to correct it. Because a running row never lingers out,
 * that ghost would stay on screen indefinitely — the exact symptom of a plugin
 * reload while a download was in flight.
 *
 * `get` is the source of truth. A settled job is folded in as settled; a job
 * the registry no longer knows (or refuses for this caller) is dropped, since a
 * row whose owner is gone can never become true again. A still-running job is
 * left alone and simply re-checked on the next pass.
 *
 * @param {{get?: Function} | undefined} service the `jobs` service, if present
 * @param {number} now
 * @param {boolean} [force] check every running row, ignoring the quiet window
 */
export function reconcileJobs(service, now = Date.now(), force = false) {
  if (!service || typeof service.get !== 'function') return
  for (const row of [...jobs.values()]) {
    if (row.status !== 'running' && row.status !== 'stopping') continue
    if (!force && now - (row.lastEventAt || row.seenAt || 0) < RECONCILE_AFTER_MS) continue
    let view
    try {
      view = service.get(row.id, row.sessionId || undefined)
    } catch {
      // Unknown or foreign: the owner was disposed, so this row is dead.
      jobs.delete(row.id)
      continue
    }
    if (!view) {
      jobs.delete(row.id)
      continue
    }
    const next = jobStatus(view.status)
    row.lastEventAt = now
    if (next === row.status) continue
    row.status = next
    if (next !== 'running' && next !== 'stopping') {
      row.finishedAt = Number(view.finishedAt) || now
    }
  }
}

/**
 * Forget everything. Only for tests, and for a host that reloads the plugin:
 * a stale row would otherwise outlive the work it describes.
 */
export function resetBackground() {
  jobs.clear()
  subs.clear()
  flows.clear()
  activeTools.clear()
}
