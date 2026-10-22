/**
 * Task lifecycle for the Host half.
 *
 * DSH notifies a plugin exactly twice per tool call (start and end), so there is
 * no progress stream to subscribe to. This module therefore *derives* progress:
 * a 1 s sampler stats the file a command is writing and turns "bytes on disk"
 * into a byte count plus a rate.
 *
 * The map is module state on purpose — one plugin instance owns one overlay, and
 * the snapshot route reads the same map the sampler writes.
 */
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { PKG_RE, extractTargets } from './detect.js'
import { clip, extractUrl, firstLine, lastLine } from './utils.js'

/** Consecutive quiet samples before a finished download is considered settled. */
export const IDLE_TICKS_TO_CLOSE = 3

/** How long a settled card stays on screen, so it does not vanish mid-read. */
export const LINGER_MS = 1200

/** Sample points kept for the speed window. Six ≈ 5 s of history at 1 Hz. */
const SPEED_WINDOW = 6

/** Minimum span before a rate is computed, so the first tick is not wild. */
const MIN_SPEED_SPAN_MS = 900

/**
 * Grace period before a not-yet-existing target counts as idle.
 *
 * A downloader spends its first moments resolving DNS and opening the socket,
 * and some write under a temporary name. Counting those ticks as idle retires a
 * `run_in_background` card before the file ever appears — and once retired the
 * card cannot come back, because the tool call it was tied to is already over.
 */
const START_GRACE_MS = 5000

/**
 * Hard ceiling on a card's lifetime, independent of progress.
 *
 * `done` alone is not enough to retire a download: a background job that dies
 * without ever creating its file, or one whose path was parsed wrong, would keep
 * counting quiet ticks against a file that never appears. Thirty minutes is far
 * past any transfer worth watching.
 */
const MAX_TASK_MS = 30 * 60 * 1000

/** @type {Map<string, object>} */
const tasks = new Map()

/**
 * Session-title lookup, installed by the wiring layer.
 *
 * Only the Host can turn a `SessionId` into the name the user sees in the
 * sidebar, and that name does not exist yet when the first download of a fresh
 * session starts: DSH generates the title asynchronously from the first prompt.
 * A task that resolved its title once, at start, would therefore keep an empty
 * label for its whole life — so the lookup is repeated from `snapshot()`.
 *
 * @type {((sessionId: string) => string) | null}
 */
let titleResolver = null

/** Re-ask for a session title at most this often, per task. */
const TITLE_TTL_MS = 2000

/**
 * Install (or clear) the Host's session-title lookup.
 *
 * @param {((sessionId: string) => string) | null} resolver
 */
export function setTitleResolver(resolver) {
  titleResolver = typeof resolver === 'function' ? resolver : null
}

/**
 * Visit every task of one kind.
 * Install cards are updated from two separate host events (log chunks and phase
 * changes) and both need "apply to all install tasks"; this keeps that loop in
 * one place instead of being written out twice.
 *
 * @param {string} kind
 * @param {(task: object, now: number) => void} mutate
 */
function forEachTask(kind, mutate) {
  const now = Date.now()
  for (const task of tasks.values()) {
    if (task.kind === kind) mutate(task, now)
  }
}

/**
 * Register a task for a dispatch that earned a card.
 *
 * @param {{callId?: string, name?: string}} exec
 * @param {{kind: string, label?: string, detail?: string, command?: string}} plan from `classify()`
 * @param {string} cwd resolved agent working directory
 * @returns {object} the task, so the caller can mark it done
 */
export function beginTask(exec, plan, cwd) {
  const startedAt = Date.now()
  const task = {
    id: String(exec?.callId ?? `${startedAt}-${Math.random()}`),
    kind: plan.kind,
    name: String(exec?.name ?? ''),
    // Which session started this call. The overlay uses it to group several
    // concurrent downloads into one small block per session, labelled with the
    // session name. Empty when the call carries no agent (never in practice).
    sessionId: String(exec?.agent?.id ?? ''),
    sessionTitle: '',
    titleAt: 0,
    label: plan.label ?? '',
    startedAt,
    bytes: 0,
    total: null,
    speed: 0,
    phase: '',
    // One line of context under the bar. Every shape fills this with whatever it
    // knows: the URL, the full query, the command, or the newest pnpm line.
    log: clip(plan.detail ?? '', 160),
    done: false,
    targets: [],
    history: [],
    idleTicks: 0,
    expiresAt: 0,
  }

  if (plan.kind === 'download') {
    task.targets = extractTargets(plan.command, cwd)
    const url = extractUrl(plan.command)
    task.label =
      task.label ||
      (task.targets.length
        ? basename(task.targets[0])
        : basename(url || '') || '下载')
    // Where the bytes come from is the most useful line; then the resolved path;
    // then the raw command when neither could be parsed.
    task.log = clip(url || task.targets[0] || firstLine(plan.command), 160)
    if (url) probeTotal(url, task)
  } else if (plan.kind === 'pkg') {
    const match = String(plan.command).match(PKG_RE)
    task.label = match ? match[1].replace(/\s+/g, ' ') : '安装'
    task.log = clip(firstLine(plan.command), 160)
  } else if (plan.kind === 'install') {
    task.log = clip('pnpm add ' + (plan.label || '…'), 160)
  }

  tasks.set(task.id, task)
  return task
}

/**
 * Best-effort total size via HEAD.
 *
 * Not every server sends `content-length`, and a HEAD can be rejected outright;
 * in both cases the card degrades to an indeterminate bar instead of showing a
 * made-up denominator.
 *
 * @param {string} url
 * @param {object} task
 */
async function probeTotal(url, task) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) })
    // A rejected HEAD still carries a body length — Cloudflare answers 403 with a
    // one-byte error page, and `content-length: 1` would then be adopted as the
    // file's size, leaving the card stuck on "0 B / 1 B". Only a successful
    // response describes the resource we are actually downloading.
    if (!res.ok) return
    const length = Number(res.headers.get('content-length'))
    if (Number.isFinite(length) && length > 0) task.total = length
  } catch {
    /* best effort: keep total = null */
  }
}

/**
 * One sampling tick for one task.
 *
 * Only downloads that resolved a literal target participate; everything else is
 * driven by host events instead. The rate is a sliding window over the last six
 * samples rather than an EMA, because an EMA's tail makes a download that has
 * already stopped still report a falling speed for several seconds.
 *
 * @param {object} task
 * @param {number} now
 */
function sample(task, now) {
  if (task.kind !== 'download' || task.targets.length === 0) return

  let size = 0
  let seen = false
  for (const target of task.targets) {
    try {
      size += statSync(target).size
      seen = true
    } catch {
      /* the file may not exist yet, or was already renamed away */
    }
  }

  if (!seen && now - task.startedAt < START_GRACE_MS) return

  task.idleTicks = size > task.bytes ? 0 : task.idleTicks + 1
  // Hold the high-water mark instead of following the file down. A downloader
  // that writes to a temporary name and renames it into place makes the sampled
  // path vanish for a tick, and reporting 0 B would snap the bar back to empty
  // right before the card is retired. Quiet ticks are still counted off `size`,
  // so the card does retire on schedule.
  if (size >= task.bytes) task.bytes = size

  task.history.push({ t: now, s: size })
  while (task.history.length > SPEED_WINDOW) task.history.shift()

  const first = task.history[0]
  const span = now - first.t
  if (span >= MIN_SPEED_SPAN_MS) {
    const grew = size - first.s
    task.speed = grew > 0 ? (grew * 1000) / span : 0
  }
}

/**
 * Advance every task and drop the settled ones.
 *
 * A task is only retired once it is both `done` (the tool returned) AND its file
 * stopped growing. That ordering is what keeps a `run_in_background` download
 * visible: the tool resolves immediately, but bytes keep arriving.
 *
 * @param {number} now
 */
export function sweep(now) {
  for (const [id, task] of tasks) {
    // Retire a card that has outlived its usefulness even if it never settles.
    if (now - task.startedAt > MAX_TASK_MS) {
      tasks.delete(id)
      continue
    }

    sample(task, now)

    const quiet =
      task.kind !== 'download' ||
      task.targets.length === 0 ||
      task.idleTicks >= IDLE_TICKS_TO_CLOSE

    if (task.done && quiet) {
      if (!task.expiresAt) task.expiresAt = now + LINGER_MS
      if (now >= task.expiresAt) tasks.delete(id)
    }
  }
}

/** Newest pnpm line, written onto every install card. */
export function noteInstallLog(chunk) {
  const line = clip(lastLine(chunk?.text), 160)
  if (!line) return
  forEachTask('install', (task) => {
    task.log = line
  })
}

/** Install phase (`installing` / `cancelling` / `applying`). */
export function noteInstallPhase(progress) {
  const phase = String(progress?.phase ?? '')
  if (!phase) return
  forEachTask('install', (task) => {
    task.phase = phase
  })
}

/**
 * Refresh one task's cached session title.
 *
 * Called from the snapshot route rather than from `beginTask` because DSH mints
 * a session title asynchronously from the first prompt: a download that starts
 * in the first seconds of a new session has no title yet, and one captured at
 * start would stay blank forever. The cache is re-validated every
 * `TITLE_TTL_MS`, so a title that lands mid-download appears on the next poll.
 *
 * @param {object} task
 * @param {number} now
 */
function refreshTitle(task, now) {
  if (!task.sessionId || !titleResolver) return
  if (task.sessionTitle && now - task.titleAt < TITLE_TTL_MS) return
  try {
    const title = titleResolver(task.sessionId)
    if (title) task.sessionTitle = String(title)
  } catch {
    /* a title lookup must never break the snapshot */
  }
  task.titleAt = now
}

/**
 * Short, stable name for a session the Host could not name.
 *
 * A session that is still early in its first turn has no generated title, and a
 * subagent session may never get one. The overlay still has to say *which*
 * session a block belongs to, so the id prefix stands in — it matches what the
 * GUI shows elsewhere and never changes for the life of the session.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function fallbackSessionTitle(sessionId) {
  const id = String(sessionId || '')
  if (!id) return ''
  // Keep the distinguishing tail of `session-<hex>`; a bare id keeps its head.
  const tail = id.slice(-8)
  return '会话 ' + tail
}

/**
 * The wire format the Client half polls.
 * Deliberately small and flat: this is serialised once per second per client.
 *
 * @returns {object[]}
 */
export function snapshot() {
  const now = Date.now()
  return [...tasks.values()].map((task) => {
    refreshTitle(task, now)
    return {
      id: task.id,
      kind: task.kind,
      name: task.name,
      label: task.label,
      // Grouping key + the human name of the session that owns this call.
      sessionId: task.sessionId,
      sessionTitle: task.sessionTitle || fallbackSessionTitle(task.sessionId),
      bytes: task.bytes,
      total: task.total,
      speed: Math.round(task.speed),
      phase: task.phase,
      log: task.log,
      startedAt: task.startedAt,
      elapsedMs: Math.max(0, now - task.startedAt),
      done: task.done,
      // A download whose target could not be parsed: the client shows an
      // indeterminate "载入中..." bar instead of a fake 0 B / 0 B.
      unresolved: task.kind === 'download' && task.targets.length === 0,
    }
  })
}
