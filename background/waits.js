/**
 * background/waits.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
import { activeTools } from './tables.js'
import { CONDITIONAL_WAIT, WAIT_TOOLS } from './tuning.js'

/**
 * Is this job the foreground command that ran it?
 *
 * A foreground shell call holds the agent for as long as it runs, so it is
 * visible in the transcript already; listing it here would double-report every
 * command the agent runs. Only a job that outlived its tool call is background
 * work.
 *
 * The answer is read off the row, not recomputed. `noteJobEvent()` decides once,
 * at registration, while the shell call that creates the registry entry is still
 * in flight — see `startedUnderShell` for what went wrong when this test asked
 * the live tool table instead.
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isForegroundJob(row) {
  return row.type === 'job' && row.foreground === true
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
