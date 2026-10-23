/**
 * Every duration and cap the sampler obeys, in one place.
 *
 * These numbers are the plugin's whole theory of how long a download may take:
 * a card is retired here, kept alive here, and bounded here. Scattering them
 * through the sampler made "why did my card vanish" unanswerable, because the
 * answer depended on which of nine constants applied. Each one carries the bug
 * that set it.
 */

/** Consecutive quiet samples before a finished download is considered settled. */
export const IDLE_TICKS_TO_CLOSE = 3

/** How long a settled card stays on screen, so it does not vanish mid-read. */
export const LINGER_MS = 1200

/**
 * How long a download may go without growing and still be kept alive by a busy
 * session.
 *
 * `isSessionBusy` is per session, so one long background download used to keep
 * every finished card in that session on screen indefinitely — a dead card that
 * never went away. Two minutes covers aria2c's 60 s default save interval (its
 * byte count only steps once a minute) with room for a slow step, while a card
 * whose transfer really stopped falls out of the list.
 */
export const BUSY_GRACE_MS = 120_000

/** Sample points kept for the speed window. Six ≈ 5 s of history at 1 Hz. */
export const SPEED_WINDOW = 6

/** Minimum span before a rate is computed, so the first tick is not wild. */
export const MIN_SPEED_SPAN_MS = 900

/**
 * How recent an aria2c `.aria2` sidecar must be to count as proof of life.
 *
 * aria2c rewrites the bitmap only every `--auto-save-interval` (60 s by default),
 * so a healthy transfer reports an unchanged byte count for up to a minute at a
 * time. The threshold is comfortably wider than that interval: a sidecar touched
 * within the last two minutes belongs to a live download.
 */
export const SIDECAR_FRESH_MS = 150_000

/**
 * How long a freshly written file must sit untouched before its size is believed.
 *
 * aria2c preallocates a target to its final length the moment it starts it, and
 * only writes the `.aria2` control file a moment later. In that gap `stat()`
 * reports the whole file while nothing has arrived. Waiting out a short quiet
 * period separates the two cases: a preallocated file is being written to right
 * now (fresh mtime), while a finished one has stopped changing.
 */
export const PREALLOC_QUIET_MS = 5000

/**
 * How long a preallocated, not-yet-measurable aria2c target keeps its card alive.
 *
 * aria2c rewrites the `.aria2` bitmap once per `--auto-save-interval` (60 s by
 * default), so a large preallocated file can report nothing at all for a full
 * minute while the transfer runs at full speed. The idle counter must not be
 * allowed to retire the card during that window; this bound is the longest the
 * bitmap can legitimately stay silent, plus slack.
 */
export const PREALLOC_GRACE_MS = 90_000

/**
 * Grace period before a not-yet-existing target counts as idle.
 *
 * A downloader spends its first moments resolving DNS and opening the socket,
 * and some write under a temporary name. Counting those ticks as idle retires a
 * `run_in_background` card before the file ever appears — and once retired the
 * card cannot come back, because the tool call it was tied to is already over.
 */
export const START_GRACE_MS = 5000

/**
 * Hard ceiling on a card's lifetime, independent of progress.
 *
 * `done` alone is not enough to retire a download: a background job that dies
 * without ever creating its file, or one whose path was parsed wrong, would keep
 * counting quiet ticks against a file that never appears.
 *
 * The ceiling must NOT cut off a transfer that is still moving, though. A 7 GiB
 * ISO on a throttled link is a two-hour download, and retiring its card at 30
 * minutes left the last hour invisible while the file kept growing — the card
 * disappeared at the exact moment it became most useful. So the ceiling only
 * applies to *stalled* cards; `sample()` resets `idleTicks` whenever bytes
 * arrive, and a stalled card retires long before this anyway.
 */
export const MAX_TASK_MS = 30 * 60 * 1000

/** Absolute backstop for a card that keeps reporting growth.
 *
 * Without one, a downloader that scribbles into its target forever (a log being
 * appended, a sparse file, a loop) would pin a card for the life of the process.
 *
 * One day, not six hours: a 7 GiB ISO from a throttled CDN really does take
 * eight hours, and a shorter backstop would cut that card off in the final
 * stretch — the same bug as the 30-minute ceiling, just further out.
 */
export const MAX_GROWING_TASK_MS = 24 * 60 * 60 * 1000

/**
 * How many entries a `git clone` measurement may walk per sample.
 *
 * A clone is the one target that is a *directory*, and `stat().size` on a
 * directory is 0 on Windows — the card sat at `0 B / 0 B` from its first tick
 * until the idle counter retired it, which happened seconds in, so every clone
 * read as a dead download. Summing the files underneath is the only honest
 * reading, but it costs a recursive walk once per second, so the walk is bounded:
 * past this many entries the measurement stops growing rather than the host
 * spending unbounded time on the main thread.
 */
export const CLONE_WALK_MAX_ENTRIES = 20000

/** Depth cap for that walk: a clone nests a handful of levels, not fifty. */
export const CLONE_WALK_MAX_DEPTH = 12

/**
 * How close to the dispatch a target's mtime must be to count as this transfer's.
 *
 * The sampler refuses to count a file that was already on disk when the dispatch
 * started, because those bytes belong to a previous transfer: re-running a
 * finished `curl -o file` read 100 % on the first frame while the new transfer
 * was still at zero. "Was it written by this dispatch?" is answered from the
 * mtime, and that comparison needs slack in both directions:
 *
 *   - NTFS stamps a write with sub-millisecond lag, and `Date.now()` only has
 *     millisecond resolution, so a dispatch that writes on its very first tick
 *     can produce an mtime a fraction of a millisecond *before* `startedAt`.
 *     Without the slack those cards stayed at 0 B forever.
 *   - The file a previous attempt left behind is minutes or hours old, so a
 *     window of a couple of seconds still tells the two apart cleanly.
 */
export const TARGET_FRESH_SLACK_MS = 2000
