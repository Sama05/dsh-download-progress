/**
 * background/tools.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
import { activeTools, shellEndedAt } from './tables.js'
import { SHELL_TOOLS } from './tuning.js'

/* ------------------------------------------------------------------ *
 * the tools/execute side — this is what makes "waiting" honest
 * ------------------------------------------------------------------ */

/**
 * A tool call began. Recorded so a background row can ask "is the owner blocked
 * on me right now", and so a subagent/workflow start can find its parent.
 *
 * @param {string} sessionId
 * @param {string} toolName
 * @param {object} args
 */
export function noteToolStart(sessionId, toolName, args) {
  const id = String(sessionId || '')
  if (!id) return
  const name = String(toolName || '')
  // A new call owns the session again, so the previous call's end time no longer
  // says anything about jobs registered from now on.
  if (SHELL_TOOLS.has(name)) shellEndedAt.delete(id)
  activeTools.set(id, {
    name,
    args: args || {},
    since: Date.now(),
  })
}

/**
 * A tool call returned.
 *
 * @param {string} sessionId
 */
export function noteToolEnd(sessionId) {
  const id = String(sessionId || '')
  const tool = activeTools.get(id)
  // Remember when a shell call ended: a job it registered is only foreground if
  // it died with the call — see `isForegroundJob`.
  if (tool && SHELL_TOOLS.has(tool.name)) shellEndedAt.set(id, Date.now())
  activeTools.delete(id)
}

/** Session id currently blocked in a tool named `name`, if any. */
export function ownerOfRunning(name) {
  for (const [sessionId, tool] of activeTools) {
    if (tool.name === name) return sessionId
  }
  return ''
}
