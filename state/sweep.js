/**
 * Retiring cards, and the two install events that keep an install card current.
 *
 * A card may only leave once it is both finished *and* quiet, which is what keeps
 * a `run_in_background` download visible after its tool call returned. The whole
 * rule is here so there is one place to explain why a card disappeared.
 */

import { clip, lastLine, text } from '../utils.js'
import { sample } from './sample.js'
import { forEachTask, tasks } from './registry.js'
import {
  BUSY_GRACE_MS,
  IDLE_TICKS_TO_CLOSE,
  LINGER_MS,
  MAX_GROWING_TASK_MS,
  MAX_TASK_MS,
} from './tuning.js'

/**
 * Retire cards that are finished.
 *
 * `isSessionBusy` reports whether a session still has running background work.
 * It exists because a tool call that *starts* a background job returns at once:
 * `task.done` is true from the first tick while the job runs for minutes, and
 * without this the card would be dropped `LINGER_MS` after the call returns.
 */
export function sweep(now, isSessionBusy = null) {
  for (const [id, task] of tasks) {
    // Retire a stale card, but never one that is still receiving bytes — see the
    // comment on MAX_TASK_MS. `idleTicks` is reset by `sample()` on every tick
    // that grows the file, so a stalled card still hits the plain ceiling first.
    const age = now - task.startedAt
    // "Growing" needs both signals: bytes were actually received (`sample()`
    // leaves `bytes` at 0 while it is still inside the start grace, so a task
    // whose file never appears must not count), and the transfer has not yet
    // accumulated enough quiet ticks to be considered stalled.
    const growing = task.bytes > 0 && task.idleTicks < IDLE_TICKS_TO_CLOSE
    const ceiling = growing ? MAX_GROWING_TASK_MS : MAX_TASK_MS
    if (age > ceiling) {
      tasks.delete(id)
      continue
    }

    sample(task, now)

    // A running background job outlives the tool call that started it, so the
    // card must outlive `done` too. A stalled download is still worth showing
    // while its job is alive — it reports 0 B/s, which is the honest reading.
    let busy = false
    try {
      busy = typeof isSessionBusy === 'function' && isSessionBusy(task.sessionId) === true
    } catch {
      /* a probe that throws must not stop the sweep */
    }

    const quiet =
      task.kind !== 'download' ||
      task.targets.length === 0 ||
      task.idleTicks >= IDLE_TICKS_TO_CLOSE

    // `busy` is per session, not per job: one long background download keeps
    // every finished card in that session alive forever. Only a download that is
    // still demonstrably moving earns the grace — an install card is driven by
    // host events instead of file growth, so it always qualifies.
    const busyGrace =
      busy &&
      (task.kind !== 'download' ||
        (task.lastGrowthAt > 0 && now - task.lastGrowthAt < BUSY_GRACE_MS))

    if (task.done && quiet && !busyGrace) {
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
  const phase = text(progress?.phase)
  if (!phase) return
  forEachTask('install', (task) => {
    task.phase = phase
  })
}
