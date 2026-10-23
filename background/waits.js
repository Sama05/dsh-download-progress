/**
 * background/waits.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
import { activeTools } from './tables.js'
import {
  CONDITIONAL_WAIT,
  FOREGROUND_GRACE_MS,
  SHELL_TOOLS,
  WAIT_TOOLS,
} from './tuning.js'

/**
 * Is this job actually the foreground command that is running right now?
 *
 * A foreground shell call holds the agent for as long as it runs, so it is
 * visible in the transcript already. Only a job that outlived its tool call is
 * background work. The test is "started while the owner's current shell call
 * was already in flight": a job that predates the call is genuinely detached,
 * which is what keeps a background job listed when the agent moves on to run a
 * foreground command.
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isForegroundJob(row) {
  if (row.type !== 'job') return false
  const owner = String(row.sessionId || '')
  if (!owner) return false
  const tool = activeTools.get(owner)
  if (!tool || !SHELL_TOOLS.has(tool.name)) return false
  return Number(row.startedAt) >= tool.since - FOREGROUND_GRACE_MS
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
