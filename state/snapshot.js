/**
 * The wire format the Client half polls, and the two derivations it needs.
 *
 * Serialised once per second per client, so the shape is flat and small on
 * purpose. `displayedBytes` and `refreshTitle` live here because they exist only
 * to make that one payload honest: a bitmap-backed count that would otherwise
 * freeze for a minute, and a session title that did not exist yet at start.
 */

import { text } from '../utils.js'
import { isBatch, tasks, titleResolver, TITLE_TTL_MS } from './registry.js'

/**
 * Refresh one task's cached session title.
 *
 * Called from the snapshot route rather than from `beginTask` because DSH mints
 * a session title asynchronously from the first prompt: a download that starts
 * in the first seconds of a new session has no title yet, and one captured at
 * start would stay blank forever. The cache is re-validated every
 * `TITLE_TTL_MS`, so a title that lands mid-download appears on the next poll.
 *
 * @param {object} task
 * @param {number} now
 */
function refreshTitle(task, now) {
  if (!task.sessionId || !titleResolver) return
  if (task.sessionTitle && now - task.titleAt < TITLE_TTL_MS) return
  try {
    const title = titleResolver(task.sessionId)
    if (title) task.sessionTitle = text(title)
  } catch {
    /* a title lookup must never break the snapshot */
  }
  task.titleAt = now
}

/**
 * Short, stable name for a session the Host could not name.
 *
 * A session that is still early in its first turn has no generated title, and a
 * subagent session may never get one. The overlay still has to say *which*
 * session a block belongs to, so the id prefix stands in — it matches what the
 * GUI shows elsewhere and never changes for the life of the session.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function fallbackSessionTitle(sessionId) {
  const id = text(sessionId)
  if (!id) return ''
  // Keep the distinguishing tail of `session-<hex>`; a bare id keeps its head.
  const tail = id.slice(-8)
  return '会话 ' + tail
}

/**
 * The byte count to put on the wire.
 *
 * aria2c writes its bitmap once per save interval (60 s by default), so the
 * measured count is frozen for a whole minute and then jumps. Polling that
 * directly made the bar sit still and then leap — which reads as "the download
 * hung" even though it is running at full speed. The gap is filled with the rate
 * already measured, capped at the file size and only while the transfer is
 * demonstrably alive (fresh sidecar, not yet settled), so the card can never
 * guess its way past 100 % or creep forward on a dead transfer.
 *
 * @param {object} task
 * @param {number} now
 * @returns {number}
 */
function displayedBytes(task, now) {
  // `expiresAt` rather than `done`: a background dispatch is `done` the moment
  // the tool returns, while its bytes keep arriving. Only a settled card (one
  // already counting down to removal) must stop moving.
  if (task.kind !== 'download' || !task.aria2 || task.expiresAt) return task.bytes
  // A batch is measured every tick from per-file sizes, so there is no
  // sixty-second gap for a projection to fill — and extrapolating a burst rate
  // across that gap made the card overshoot the real count, show 100 % while a
  // fifth of the batch was still arriving, and then step back. Batch cards show
  // the measurement alone.
  if (isBatch(task)) return task.bytes
  if (task.idleTicks > 0 || task.speed <= 0) return task.bytes
  // Projection needs a ceiling to be bounded by. A bulk download whose HEAD
  // probes did not all answer carries no `total`, and extrapolating without one
  // let the count run away from the real byte total and then snap back on the
  // next sample — the card climbed to several times the file size and stepped
  // backwards. With no total, the honest answer is the last measurement.
  const ceiling = task.total
  if (!ceiling || ceiling <= 0) return task.bytes
  const elapsed = (now - (task.lastGrowthAt || task.startedAt)) / 1000
  if (elapsed <= 0) return task.bytes
  const projected = task.bytes + task.speed * elapsed
  // Never reach the ceiling by projection: only a real measurement may say the
  // transfer is complete, otherwise the card would show 100 % early and then
  // have to walk backwards.
  return Math.min(projected, ceiling - 1)
}

/**
 * The wire format the Client half polls.
 * Deliberately small and flat: this is serialised once per second per client.
 *
 * @returns {object[]}
 */
export function snapshot() {
  const now = Date.now()
  return [...tasks.values()].map((task) => {
    refreshTitle(task, now)
    return {
      id: task.id,
      kind: task.kind,
      name: task.name,
      label: task.label,
      // Grouping key + the human name of the session that owns this call.
      sessionId: task.sessionId,
      sessionTitle: task.sessionTitle || fallbackSessionTitle(task.sessionId),
      bytes: displayedBytes(task, now),
      total: task.total,
      speed: Math.round(task.speed),
      phase: task.phase,
      log: task.log,
      startedAt: task.startedAt,
      elapsedMs: Math.max(0, now - task.startedAt),
      done: task.done,
      // The downloader writes its bytes somewhere else and renames them onto the
      // target at the end, so the target never grows. The client shows elapsed
      // time instead of a bar that could only ever read 0 %.
      staged: task.staged === true,
      // A download whose target could not be parsed: the client shows an
      // indeterminate "载入中..." bar instead of a fake 0 B / 0 B.
      unresolved: task.kind === 'download' && task.targets.length === 0,
      // Which layer is measuring this task, so the client can explain a card
      // that has no percentage instead of leaving it blank. `file` is the disk
      // sampler, `stream` is the undici wrapper, `none` means neither can see
      // this kind of work at all.
      progressSource: task.progressSource || 'none',
    }
  })
}
