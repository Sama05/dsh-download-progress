/**
 * background/waits.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
import { activeTools, shellEndedAt } from './tables.js'
import { CONDITIONAL_WAIT, SHELL_SETTLE_MS, WAIT_TOOLS } from './tuning.js'

/**
 * Is this job the foreground command that ran it?
 *
 * A foreground shell call holds the agent for as long as it runs, so it is
 * visible in the transcript already; listing it here would double-report every
 * command the agent runs. Only a job that outlived its tool call is background
 * work.
 *
 * The row records what the table said at registration (`underShell`) instead of
 * the answer, because the two cases it cannot yet tell apart — a foreground
 * command's own registry entry, and a job the call deliberately detached — look
 * identical while the call is in flight. Two things settle it:
 *
 *   1. `detached`: the call passed `run_in_background`. Freezing this row as
 *      foreground is what once hid every real background job for good.
 *   2. The call has returned and the entry is still running. A foreground entry
 *      is settled by the shell tool as it returns, so one that survives the call
 *      is background work. The settle event travels on the bus and can land a
 *      moment after the return, hence `SHELL_SETTLE_MS` before that is believed.
 *
 * @param {object} row
 * @param {number} [now]
 * @returns {boolean}
 */
export function isForegroundJob(row, now = Date.now()) {
  if (row.type !== 'job' || row.underShell !== true) return false
  if (row.detached === true) return false
  // The call is still in flight: either case is possible, and the transcript
  // already shows the call, so stay out of the way.
  const endedAt = shellEndedAt.get(String(row.sessionId || '')) || 0
  if (endedAt === 0) return true
  if (now - endedAt < SHELL_SETTLE_MS) return true
  // Past the settle window the question is answered by what the entry did: a
  // foreground entry is settled as the call returns and this one is still
  // running, which means the call left it behind. A settled entry that was
  // registered under a shell call is the call's own record and never surfaces.
  const live = row.status === 'running' || row.status === 'stopping'
  return !live
}

/**
 * Is this row the thing its owner is blocked on?
 *
 * Only a blocking tool counts. `job_output` with `wait:false` polls and returns
 * immediately, so it must not light up "waiting".
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isWaitedOn(row) {
  if (row.status !== 'running') return false
  const owner = String(row.sessionId || '')
  if (owner) {
    const tool = activeTools.get(owner)
    if (!tool) return false
    return blocksOn(tool, row)
  }
  // No known owner (a subagent whose parent could not be inferred): fall back
  // to "some session is blocked in the matching tool".
  for (const tool of activeTools.values()) {
    if (blocksOn(tool, row)) return true
  }
  return false
}

/** Does `tool` block until a row of this type finishes? */
function blocksOn(tool, row) {
  const name = tool.name
  if (row.type === 'job') {
    if (name === 'job_wait') return true
    if (name === 'job_output') {
      const gate = CONDITIONAL_WAIT.job_output
      return gate(tool.args)
    }
    return false
  }
  if (row.type === 'subagent') return name === 'subagent' || name === 'subagent_fork'
  if (row.type === 'workflow') return name === 'workflow'
  return WAIT_TOOLS.has(name)
}
