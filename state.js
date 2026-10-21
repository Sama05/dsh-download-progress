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

/** @type {Map<string, object>} */
const tasks = new Map()

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
  for (const target of task.targets) {
    try {
      size += statSync(target).size
    } catch {
      /* the file may not exist yet, or was already renamed away */
    }
  }

  task.idleTicks = size > task.bytes ? 0 : task.idleTicks + 1
  task.bytes = size

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
 * The wire format the Client half polls.
 * Deliberately small and flat: this is serialised once per second per client.
 *
 * @returns {object[]}
 */
export function snapshot() {
  const now = Date.now()
  return [...tasks.values()].map((task) => ({
    id: task.id,
    kind: task.kind,
    name: task.name,
    label: task.label,
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
  }))
}
