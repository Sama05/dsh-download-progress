/**
 * background.js — what the agent is doing *besides* the transfer on screen.
 *
 * The overlay has always answered "how far along is this download". This module
 * answers a different question: "is anything else still running for this
 * session, and is the agent stuck waiting on it".
 *
 * Three producers, all optional, all observed read-only:
 *
 *   jobs        bash background jobs. `jobs` service events carry the owner
 *               session, a status and the progress line the producer wrote.
 *   subagent    `subagent/start` / `subagent/end`. The event carries the child
 *               session id but NOT the parent, so ownership is inferred from
 *               the parent that is currently blocked on the subagent tool.
 *   workflow    `workflow/start` / `phase` / `log` / `end`. Same shape of
 *               problem, same inference.
 *
 * Nothing here changes a dispatch decision and nothing throws outward: a host
 * without the jobs plugin, or an event with a shape this file does not know,
 * simply produces no background rows.
 *
 * ## "running" and "waiting" are not the same thing
 *
 * A job can be running while the agent happily does something else. Showing
 * "agent is waiting" then would be a lie. Waiting is only claimed when the
 * owning session's current tool call is one that blocks on background work —
 * see tuning.js. That state is read from `tools/execute`, which is blocked for
 * exactly as long as the tool is.
 *
 * ## Layout
 *
 * This file is a barrel: the implementation is `background/*.js`, one module
 * per concern, so no single file has to hold the whole bookkeeping model.
 */

export { RECONCILE_AFTER_MS } from './background/tuning.js'
export { setTitleLookup } from './background/tables.js'
export { noteJobEvent } from './background/jobs.js'
export { noteSubagentStart, noteSubagentEnd } from './background/subagent.js'
export {
  noteWorkflowStart,
  noteWorkflowPhase,
  noteWorkflowLog,
  noteWorkflowEnd,
} from './background/workflow.js'
export { noteToolStart, noteToolEnd } from './background/tools.js'
export { backgroundSnapshot, reconcileJobs, resetBackground } from './background/snapshot.js'
