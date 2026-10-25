/**
 * background/workflow.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
import { flows } from './tables.js'
import { ownerOfRunning } from './tools.js'

/* ------------------------------------------------------------------ *
 * workflow
 * ------------------------------------------------------------------ */

/**
 * A workflow run started.
 *
 * @param {object} info WorkflowRunInfo
 */
export function noteWorkflowStart(info) {
  if (!info || !info.id) return
  const runId = String(info.id)
  const meta = info.meta || {}
  const phase = Array.isArray(meta.phases) && meta.phases[0] ? meta.phases[0].title : ''
  // Same rule as a subagent row: a run with no owning session is not recorded,
  // because nothing can be waiting on it and the row would then appear in every
  // session's overlay with no way to attribute it.
  const owner = ownerOfRunning('workflow') || ''
  if (!owner) return
  flows.set(runId, {
    id: runId,
    type: 'workflow',
    label: String(meta.name || '工作流'),
    detail: String(phase || ''),
    sessionId: owner,
    sessionTitle: '',
    status: 'running',
    kind: 'workflow',
    startedAt: Date.now(),
    finishedAt: 0,
    seenAt: Date.now(),
  })
}

/**
 * The script entered a phase — the most useful progress a workflow offers.
 *
 * @param {object} info WorkflowRunInfo
 * @param {string} phaseTitle
 */
export function noteWorkflowPhase(info, phaseTitle) {
  const row = info && info.id ? flows.get(String(info.id)) : null
  if (row) row.detail = String(phaseTitle || '')
}

/**
 * A narration line. Kept because a long-running workflow's only heartbeat is
 * its log, and an empty detail reads as "stuck".
 *
 * @param {object} info WorkflowRunInfo
 * @param {string} message
 */
export function noteWorkflowLog(info, message) {
  const row = info && info.id ? flows.get(String(info.id)) : null
  if (!row) return
  const line = String(message || '').trim()
  if (line) row.detail = line.slice(0, 120)
}

/**
 * A workflow run settled.
 *
 * @param {object} info WorkflowRunInfo
 */
export function noteWorkflowEnd(info) {
  const row = info && info.id ? flows.get(String(info.id)) : null
  if (!row) return
  row.status = 'done'
  row.finishedAt = Date.now()
}
