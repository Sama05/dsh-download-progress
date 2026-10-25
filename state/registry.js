/**
 * The one task map, and the handles the rest of `state/` reads it through.
 *
 * Module state on purpose: one plugin instance owns one overlay, and the snapshot
 * route reads the same map the sampler writes. Kept in its own module so that
 * "who can mutate a card" has a single file to audit — everything else in the
 * folder takes the map from here rather than declaring its own.
 */

/**
 * Targets seen with an `.aria2` sidecar, per task.
 *
 * Kept outside the task object so it never reaches the wire payload: it is
 * bookkeeping for `sample()`, not something the overlay renders.
 */
export const sidecarsSeen = new WeakMap()

/**
 * Whether a card covers several files rather than one.
 *
 * A batch is measured as a sum over its files, and aria2c restarts a file that
 * timed out, so the sum can genuinely fall mid-transfer. On a single file that
 * correction is worth showing; on a batch it only makes the bar walk backwards,
 * which reads as a bug. Batch cards therefore hold a high-water mark and skip
 * the rate projection (they are re-measured every tick, so there is no gap to
 * fill).
 *
 * @param {object} task
 * @returns {boolean}
 */
export function isBatch(task) {
  return Boolean(task?.bulk) || (task?.targets?.length ?? 0) > 1
}

/** @type {Map<string, object>} */
export const tasks = new Map()

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
export let titleResolver = null

/** Re-ask for a session title at most this often, per task. */
export const TITLE_TTL_MS = 2000

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
export function forEachTask(kind, mutate) {
  const now = Date.now()
  for (const task of tasks.values()) {
    if (task.kind === kind) mutate(task, now)
  }
}

/**
 * Which build the Host half is running.
 *
 * Published on the snapshot so a stale cached bundle can be told apart from a
 * fresh one at a glance: when the card misbehaves, this is the first thing to
 * read. Keep it in step with `version` in package.json.
 */
export const BUILD_TAG = '0.3.0'

/**
 * The live card already watching a given path in the same session, if any.
 *
 * Only one card per file per session is allowed: two cards sampling the same file
 * report the same byte count, so the second one is pure noise — and a retry is
 * exactly how that happens in practice. The session is part of the key because
 * two sessions watching the same shared path are genuinely two things happening,
 * and each deserves its own row.
 *
 * @param {string} target absolute path
 * @param {string} sessionId
 * @returns {object | undefined}
 */
export function findByTarget(target, sessionId) {
  const key = target.toLowerCase()
  for (const task of tasks.values()) {
    if (task.kind !== 'download' || task.targets.length !== 1) continue
    if (task.sessionId !== sessionId) continue
    if (task.targets[0].toLowerCase() === key) return task
  }
  return undefined
}

/**
 * Hand an existing card over to a new dispatch that writes the same file.
 *
 * The transfer restarts, so the age, the idle count and the done flag all reset;
 * the measured size is kept because the file on disk really is that big (a
 * `curl -C -` resume continues where the last attempt stopped). The card keeps
 * its position in the list rather than jumping to the end.
 *
 * @param {object} task the existing card
 * @param {{id: string, startedAt: number}} fresh identity of the new dispatch
 * @returns {object} the same card, adopted
 */
export function retarget(task, { id, startedAt }) {
  tasks.delete(task.id)
  task.id = id
  task.startedAt = startedAt
  task.done = false
  task.expiresAt = 0
  task.idleTicks = 0
  task.history = []
  task.lastGrowthAt = 0
  // The new attempt has its own start time, so the mtime proof it left on the
  // target has to be re-established — see `freshTarget` in `sample()`.
  task.freshTarget = false
  // Keep the high-water mark: the resumed file is at least as large as the card
  // last saw. Reporting 0 B here would snap the bar back to empty mid-transfer.
  tasks.set(id, task)
  return task
}
