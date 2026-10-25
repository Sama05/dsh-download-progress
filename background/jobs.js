/**
 * background/jobs.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
import { activeTools, jobs } from './tables.js'
import { FOREGROUND_GRACE_MS, SHELL_TOOLS } from './tuning.js'

/**
 * Was this job registered while its owner sat inside a shell call?
 *
 * Asked once, at registration, and then remembered on the row — never re-asked.
 * The re-asking is what produced a ghost: a foreground `pwsh` command returns,
 * `noteToolEnd()` clears the active tool, and from that moment the test "is the
 * owner blocked in a shell call" answered no for a job that had been foreground
 * all along. The row therefore surfaced `LINGER_MS` after the command finished —
 * a card that appeared out of nowhere seconds after nothing happened, then
 * vanished on its own. Worse, while a *download* was still running, that
 * resurrected row made the session look busy and kept the download card on
 * screen for two more minutes after it had been interrupted.
 *
 * @param {string} sessionId the job's owner
 * @param {number} startedAt the job's own start, not the registration time
 * @returns {boolean}
 */
function startedUnderShell(sessionId, startedAt) {
  const tool = activeTools.get(sessionId)
  if (!tool || !SHELL_TOOLS.has(tool.name)) return false
  return Number(startedAt) >= tool.since - FOREGROUND_GRACE_MS
}

/* ------------------------------------------------------------------ *
 * jobs
 * ------------------------------------------------------------------ */

/**
 * Fold one `jobs` service event into the table.
 *
 * @param {object} event a JobEvent
 */
export function noteJobEvent(event) {
  if (!event || typeof event !== 'object') return
  const job = event.job
  if (!job || !job.id) return

  if (event.type === 'removed') {
    jobs.delete(job.id)
    return
  }

  const previous = jobs.get(job.id)
  const sessionId = String(job.owner || '')
  const startedAt = Number(job.startedAt) || Date.now()
  jobs.set(job.id, {
    id: String(job.id),
    type: 'job',
    label: String(job.label || job.kind || '后台任务'),
    detail: String(job.progress || job.detail || ''),
    sessionId,
    sessionTitle: '',
    status: jobStatus(job.status),
    // The producer's own kind is `bash` today; keeping it as detail means a
    // future kind shows up in the subtitle without a UI change.
    kind: String(job.kind || ''),
    startedAt,
    // Fixed at registration — see `startedUnderShell`. A later event for the
    // same job keeps whatever the first one decided, because only the moment the
    // job was created can tell a shell call's own output registry apart from a
    // genuinely detached job.
    foreground: previous ? previous.foreground : startedUnderShell(sessionId, startedAt),
    finishedAt: job.finishedAt ? Number(job.finishedAt) : 0,
    // A job that was already listed keeps its settle time; a fresh one starts now.
    seenAt: previous ? previous.seenAt : Date.now(),
    // Last time any lifecycle event touched this row; drives reconciliation.
    lastEventAt: Date.now(),
  })
}

/** Map the service's status vocabulary onto the three the UI draws. */
export function jobStatus(status) {
  switch (status) {
    case 'running':
      return 'running'
    case 'stopping':
      return 'stopping'
    case 'completed':
      return 'done'
    default:
      return 'failed'
  }
}
