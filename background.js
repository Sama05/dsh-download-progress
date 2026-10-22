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
 * see WAIT_TOOLS. That state is read from `tools/execute`, which is blocked for
 * exactly as long as the tool is.
 */

/** Tools whose call does not return until background work finishes. */
const WAIT_TOOLS = new Set([
  'job_output', // only when wait:true, checked separately
  'job_wait',
  'subagent',
  'subagent_fork',
  'workflow',
])

/** Tools that block only with a specific argument. */
const CONDITIONAL_WAIT = {
  job_output: (args) => args && args.wait === true,
}

/**
 * Shell tools. Their foreground calls ALSO register a `jobs` entry while they
 * run — the registry is what the shell tool uses to stream output, and a
 * foreground call removes its entry when it returns. Those entries are not
 * background work: the transcript already shows the call, and painting a second
 * row for it would double-report every command the agent runs.
 */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'exec'])

/** Slack when matching a job's start against the call that is running it. */
const FOREGROUND_GRACE_MS = 1000

/** A background row disappears this long after it settles. */
const LINGER_MS = 4000

/** Upper bound on rows, so a runaway producer cannot grow the payload. */
const MAX_ROWS = 20

/** @type {Map<string, object>} job id -> row */
const jobs = new Map()
/** @type {Map<string, object>} child session id -> row */
const subs = new Map()
/** @type {Map<string, object>} workflow run id -> row */
const flows = new Map()
/** @type {Map<string, object>} session id -> the tool it is currently blocked in */
const activeTools = new Map()

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
function title(sessionId) {
  if (!sessionId) return ''
  try {
    return String(titleOf(sessionId) || '')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * jobs
 * ------------------------------------------------------------------ */

/**
 * Fold one `jobs` service event into the table.
 *
 * @param {object} event a JobEvent
 */
export function noteJobEvent(event) {
  if (!event || typeof event !== 'object') return
  const job = event.job
  if (!job || !job.id) return

  if (event.type === 'removed') {
    jobs.delete(job.id)
    return
  }

  const previous = jobs.get(job.id)
  jobs.set(job.id, {
    id: String(job.id),
    type: 'job',
    label: String(job.label || job.kind || '后台任务'),
    detail: String(job.progress || job.detail || ''),
    sessionId: String(job.owner || ''),
    sessionTitle: '',
    status: jobStatus(job.status),
    // The producer's own kind is `bash` today; keeping it as detail means a
    // future kind shows up in the subtitle without a UI change.
    kind: String(job.kind || ''),
    startedAt: Number(job.startedAt) || Date.now(),
    finishedAt: job.finishedAt ? Number(job.finishedAt) : 0,
    // A job that was already listed keeps its settle time; a fresh one starts now.
    seenAt: previous ? previous.seenAt : Date.now(),
  })
}

/** Map the service's status vocabulary onto the three the UI draws. */
function jobStatus(status) {
  switch (status) {
    case 'running':
      return 'running'
    case 'stopping':
      return 'stopping'
    case 'completed':
      return 'done'
    default:
      return 'failed'
  }
}

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
  flows.set(runId, {
    id: runId,
    type: 'workflow',
    label: String(meta.name || '工作流'),
    detail: String(phase || ''),
    sessionId: ownerOfRunning('workflow') || '',
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
function ownerOfRunning(name) {
  for (const [sessionId, tool] of activeTools) {
    if (tool.name === name) return sessionId
  }
  return ''
}

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
function isForegroundJob(row) {
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
function isWaitedOn(row) {
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

/* ------------------------------------------------------------------ *
 * snapshot
 * ------------------------------------------------------------------ */

/**
 * The background half of the wire body.
 *
 * Rows are ordered waiting-first, then newest first, so the row a user cares
 * about ("the agent is stuck on this") is the one at the top of a short list.
 *
 * @param {number} now
 * @returns {object[]}
 */
export function backgroundSnapshot(now = Date.now()) {
  const rows = []
  for (const row of [...jobs.values(), ...subs.values(), ...flows.values()]) {
    // Drop settled rows once they have lingered long enough to be noticed.
    if (row.status !== 'running' && row.status !== 'stopping') {
      if (now - (row.finishedAt || row.seenAt || 0) > LINGER_MS) continue
    }
    // A foreground command is already in the transcript; listing it here would
    // double-report it and claim "the agent is waiting" for a plain tool call.
    if (isForegroundJob(row)) continue
    const sessionId = String(row.sessionId || '')
    rows.push({
      id: row.id,
      type: row.type,
      label: row.label,
      detail: row.detail,
      sessionId,
      sessionTitle: sessionId ? title(sessionId) : '',
      status: row.status,
      waiting: isWaitedOn(row),
      startedAt: row.startedAt,
      elapsedMs: Math.max(0, now - row.startedAt),
    })
  }

  rows.sort((a, b) => {
    if (a.waiting !== b.waiting) return a.waiting ? -1 : 1
    return b.startedAt - a.startedAt
  })
  return rows.slice(0, MAX_ROWS)
}

/**
 * Forget everything. Only for tests, and for a host that reloads the plugin:
 * a stale row would otherwise outlive the work it describes.
 */
export function resetBackground() {
  jobs.clear()
  subs.clear()
  flows.clear()
  activeTools.clear()
}
