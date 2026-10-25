/**
 * background/tables.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
/** @type {Map<string, object>} job id -> row */
export const jobs = new Map()
/** @type {Map<string, object>} child session id -> row */
export const subs = new Map()
/** @type {Map<string, object>} workflow run id -> row */
export const flows = new Map()
/** @type {Map<string, object>} session id -> the tool it is currently blocked in */
export const activeTools = new Map()
/** @type {Map<string, number>} session id -> when its last shell call returned */
export const shellEndedAt = new Map()

/** Resolves a session id to its display name; replaced by index.js. */
let titleOf = () => ''

/**
 * Install the session-title lookup.
 *
 * @param {(sessionId: string) => string} fn
 */
export function setTitleLookup(fn) {
  if (typeof fn === 'function') titleOf = fn
}

/** Never let a title lookup break a snapshot. */
export function title(sessionId) {
  if (!sessionId) return ''
  try {
    return String(titleOf(sessionId) || '')
  } catch {
    return ''
  }
}
