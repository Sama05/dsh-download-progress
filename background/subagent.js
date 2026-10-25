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
 * The event carries no parent id, and the host's emitter consumes it for scoped
 * dispatch rather than handing it to listeners (it calls `callback(info)`), so
 * the parent is taken from whichever session is currently blocked inside the
 * subagent tool. That is exact when one delegation is in flight and best-effort
 * when several are; a wrong guess only costs the grouping label, never a wrong
 * status. A child with no owner at all is not recorded — see below.
 *
 * @param {object} info SubagentRunInfo
 */
export function noteSubagentStart(info) {
  if (!info || !info.id) return
  const childId = String(info.id)
  const owner = ownerOfRunning('subagent') || ownerOfRunning('subagent_fork') || ''
  // A child nobody is waiting for is not "the agent's background work".
  //
  // Some producers start a subagent outside the tool system entirely — an idle
  // housekeeping checkpoint is the one seen in practice. There is no session
  // blocked in the subagent tool, so no owner can be inferred, and the row used
  // to be filed anyway under sessionId ''. Because the client's "current session
  // only" filter is off by default, that ownerless row then appeared in EVERY
  // session's overlay as a permanent "子代理 · 运行中" — a background task the
  // user could never attribute and never wait on. Dropping it keeps the rule
  // the rest of this module already follows: a row exists to explain why the
  // agent is quiet, and an unattached child explains nothing.
  if (!owner) return
  subs.set(childId, {
    id: childId,
    type: 'subagent',
    label: title(childId) || '子代理',
    detail: String(info.provider || ''),
    sessionId: owner,
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
