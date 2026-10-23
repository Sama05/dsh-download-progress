/**
 * background/tools.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
import { activeTools } from './tables.js'

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
  activeTools.set(id, {
    name: String(toolName || ''),
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
  activeTools.delete(String(sessionId || ''))
}

/** Session id currently blocked in a tool named `name`, if any. */
export function ownerOfRunning(name) {
  for (const [sessionId, tool] of activeTools) {
    if (tool.name === name) return sessionId
  }
  return ''
}
