/**
 * background/jobs.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
import { jobs } from './tables.js'

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
  jobs.set(job.id, {
    id: String(job.id),
    type: 'job',
    label: String(job.label || job.kind || '后台任务'),
    detail: String(job.progress || job.detail || ''),
    sessionId: String(job.owner || ''),
    sessionTitle: '',
    status: jobStatus(job.status),
    // The producer's own kind is `bash` today; keeping it as detail means a
    // future kind shows up in the subtitle without a UI change.
    kind: String(job.kind || ''),
    startedAt: Number(job.startedAt) || Date.now(),
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
