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
 * What the shell call was doing when this job appeared.
 *
 * Two facts are recorded instead of the boolean "is it foreground", because the
 * boolean cannot be known yet: a foreground command's registry entry and a
 * `run_in_background` job both appear while the call is in flight, and only the
 * call's return tells them apart. `foreground` used to be frozen here, which
 * made every `run_in_background` job invisible for good — it was registered
 * under the shell call, so it was filed as foreground and dropped from every
 * snapshot, while its download card sat there with nothing to explain it.
 *
 * `underShell` says the call was in flight (the row may be foreground);
 * `detached` says the call asked for a background job, which no filtering can
 * apply to. See `isForegroundJob` for the reading taken later.
 *
 * @param {string} sessionId the job's owner
 * @param {number} startedAt the job's own start, not the registration time
 * @returns {{underShell: boolean, detached: boolean}}
 */
function shellContext(sessionId, startedAt) {
  const tool = activeTools.get(sessionId)
  if (!tool || !SHELL_TOOLS.has(tool.name)) return { underShell: false, detached: false }
  if (Number(startedAt) < tool.since - FOREGROUND_GRACE_MS) return { underShell: false, detached: false }
  return { underShell: true, detached: tool.args?.run_in_background === true }
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
  // Fixed once, at registration: only the moment a job appears can say whether a
  // shell call was in flight, and only that call's arguments can say it asked for
  // a background job. A later event for the same job keeps the first answer.
  const context = previous
    ? { underShell: previous.underShell, detached: previous.detached }
    : shellContext(sessionId, startedAt)
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
    // Fixed at registration — see `shellContext`.
    underShell: context.underShell,
    detached: context.detached,
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
