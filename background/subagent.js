/**
 * background/subagent.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
import { title, subs } from './tables.js'
import { ownerOfRunning } from './tools.js'

/* ------------------------------------------------------------------ *
 * subagent
 * ------------------------------------------------------------------ */

/**
 * A child session was published.
 *
 * The event has no parent id, so the parent is taken from whichever session is
 * currently blocked inside the subagent tool. That is exact when one delegation
 * is in flight and best-effort when several are; a wrong guess only costs the
 * grouping label, never a wrong status.
 *
 * @param {object} info SubagentRunInfo
 */
export function noteSubagentStart(info) {
  if (!info || !info.id) return
  const childId = String(info.id)
  subs.set(childId, {
    id: childId,
    type: 'subagent',
    label: title(childId) || '子代理',
    detail: String(info.provider || ''),
    sessionId: ownerOfRunning('subagent') || ownerOfRunning('subagent_fork') || '',
    sessionTitle: '',
    status: 'running',
    kind: String(info.provider || ''),
    startedAt: Date.now(),
    finishedAt: 0,
    seenAt: Date.now(),
  })
}

/**
 * A published child settled.
 *
 * @param {object} info SubagentRunEndInfo — only the id is relied on.
 */
export function noteSubagentEnd(info) {
  const id = String((info && (info.id || info.runId)) || '')
  const row = id ? subs.get(id) : null
  if (!row) return
  row.status = info && info.error ? 'failed' : 'done'
  row.finishedAt = Date.now()
}
