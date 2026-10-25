/**
 * One sampling tick: measure the target, then turn the measurement into a rate.
 *
 * Deliberately separate from `sweep.js`, which decides *when* a card is retired.
 * This file only answers "how fast is it going right now", and most of its length
 * is the exceptions that answer would be wrong without: preallocation, a batch
 * whose sum may fall, a bitmap written once a minute, a flat window that is not a
 * stall.
 */

import { statSync } from 'node:fs'
import { aria2Completed, directoryBytes } from './disk.js'
import { isBatch, sidecarsSeen } from './registry.js'
import {
  MIN_SPEED_SPAN_MS,
  PREALLOC_GRACE_MS,
  PREALLOC_QUIET_MS,
  SIDECAR_FRESH_MS,
  SPEED_WINDOW,
  START_GRACE_MS,
  TARGET_FRESH_SLACK_MS,
} from './tuning.js'

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
export function sample(task, now) {
  if (task.kind !== 'download' || task.targets.length === 0) return

  let size = 0
  let seen = false
  // aria2c allocates the target to its final size before the first byte lands,
  // so `stat().size` reads 100 % while nothing has arrived. Its `.aria2` sidecar
  // is written a moment *later* than the preallocation, which means the first
  // tick or two can only see the inflated stat() value. Recording that as a
  // high-water mark pinned the bar at 100 % for the rest of the transfer; a
  // sidecar measurement therefore has to be allowed to bring the number back
  // down. Every other sample still respects the high-water mark, so a downloader
  // that renames its temp file into place does not snap the bar to empty.
  let measured = false
  // aria2c rewrites its `.aria2` bitmap only every 60 s (`--auto-save-interval`),
  // so a perfectly healthy transfer can report the *same* byte count for a whole
  // minute. Counting those ticks as idle retired the card three seconds in, while
  // the download was still running at full speed. A sidecar whose mtime is recent
  // is therefore proof of life, not a stall.
  let sidecarFresh = false
  // True when a target exists at its full size but aria2c has not started
  // writing into it yet. Such a transfer is alive and simply unmeasurable: the
  // bitmap lands up to a minute later.
  let preallocated = false
  let seenSidecars = sidecarsSeen.get(task)
  if (!seenSidecars) {
    seenSidecars = new Set()
    sidecarsSeen.set(task, seenSidecars)
  }
  for (const target of task.targets) {
    try {
      // A clone target is a directory: `stat()` reports size 0 for every one of
      // them, so the generic branch below recorded nothing and the idle counter
      // retired the card a few seconds into a clone that was still running. The
      // sum of the files underneath is the only reading that moves.
      if (task.clone) {
        const walked = directoryBytes(target)
        if (walked > 0) {
          size += walked
          seen = true
        }
        continue
      }
      // Only aria2c writes a `.aria2` control file. Probing for one on every
      // other downloader costs a thrown-and-caught ENOENT for every target on
      // every tick — half the sampling budget on thirty ordinary cards — and a
      // leftover sidecar beside a curl output describes a stranger's transfer,
      // not this one. `task.aria2` comes from the command line and is already
      // trusted for the preallocation rule below.
      const done = task.aria2 ? aria2Completed(target) : undefined
      if (done !== undefined) {
        measured = true
        seenSidecars.add(target)
        try {
          if (now - statSync(`${target}.aria2`).mtimeMs < SIDECAR_FRESH_MS) sidecarFresh = true
        } catch {
          /* the sidecar vanished between the two calls: treat it as stale */
        }
        // The bitmap is rewritten once per auto-save interval (60 s by default),
        // so `done` can be a whole minute stale — a batch card sat frozen at
        // 80 % for two minutes while the last file was still arriving. The file's
        // own size is live and is the honest count for a batch, but only while it
        // is still short of the size the probe reported: once it reaches that
        // size aria2c may merely have preallocated it, and only the bitmap can
        // then tell preallocation from progress.
        let contribution = done
        const finalSize = task.bulkSizes?.get(target)
        if (finalSize > 0) {
          try {
            const live = statSync(target).size
            if (live > done && live < finalSize) contribution = live
          } catch {
            /* not on disk yet: keep the bitmap reading */
          }
        }
        size += contribution
        seen = true
        continue
      }
      // No sidecar. aria2c deletes it on completion, but it also does not write
      // one until a moment after preallocating the file — and in both states
      // `stat()` already reports the final size. Trusting that gap counted a
      // file the instant aria2c started it, then dropped the count again when
      // the sidecar appeared at zero, which is the backwards step a batch card
      // showed. A target that once had a sidecar is complete; one whose mtime
      // has gone quiet finished between two samples; a file written moments ago
      // is merely preallocated and contributes nothing yet.
      const st = statSync(target)
      // A target that already exists when the dispatch starts carries the byte
      // count of *a previous* transfer, not this one: re-running a finished
      // `curl -o file` (or resuming it) found the old 29.6 MB file still on disk,
      // adopted it as the measurement, and the card read 100 % from its first
      // frame while the new transfer was still at zero. Nothing may be counted
      // until the running downloader has touched the file itself — curl
      // truncates it (size drops to what has arrived), aria2c preallocates, and
      // a resume rewrites the tail — and each of those moves the mtime into this
      // dispatch's own window. The wait is bounded by START_GRACE_MS below, so a
      // file the downloader never touches still retires on the idle counter.
      if (!task.freshTarget && st.mtimeMs < task.startedAt - TARGET_FRESH_SLACK_MS) continue
      task.freshTarget = true
      if (task.aria2) {
        if (!seenSidecars.has(target) && now - st.mtimeMs < PREALLOC_QUIET_MS) {
          // Preallocated and not yet under way. Recorded so the card below knows
          // the transfer is real and merely unmeasurable, not stalled.
          preallocated = true
          continue
        }
      }
      size += st.size
      seen = true
    } catch {
      /* the file may not exist yet, or was already renamed away */
    }
  }

  // An aria2c target is preallocated to its final size before the first byte
  // lands, so `stat()` reports the whole file straight away. Before the sidecar
  // exists there is simply no honest number to show: reporting the preallocation
  // pinned the bar at 100 %, and dividing its growth by the sampling interval
  // reported 2.8 GB/s on a 30 MB/s transfer. Wait for the sidecar instead.
  //
  // A sidecar that never appears is not a stall: aria2c deletes it the moment the
  // transfer completes, so an ordinary "file already downloaded" run has none.
  // Those ticks count as quiet and let a finished card settle as usual.
  if (task.aria2 && !measured && !seen) {
    if (now - task.startedAt < START_GRACE_MS) return
    // A preallocated target whose mtime is still fresh is a live transfer that
    // simply has no number yet: aria2c can hold off writing the control file for
    // minutes, so a fixed grace window retires the card moments before the first
    // bitmap lands. Freshness of the file itself is the evidence of life; once
    // it stops being written the ordinary idle counter takes over.
    if (preallocated) return
    // Nothing on disk at all yet. A task that already knows its total is a real
    // transfer that is not measurable yet, but only for as long as a bitmap can
    // legitimately stay silent.
    if (task.total > 0 && now - task.startedAt < PREALLOC_GRACE_MS) return
    task.idleTicks += 1
    return
  }

  if (!seen && now - task.startedAt < START_GRACE_MS) return

  const previous = task.bytes
  const grew = size > previous

  task.idleTicks = grew || sidecarFresh ? 0 : task.idleTicks + 1
  // Hold the high-water mark instead of following the file down, except for a
  // sidecar reading: that one is authoritative and may correct a preallocation.
  //
  // A batch sum is different. aria2c retries a file that timed out, which
  // truncates it and restarts its piece count, so the sum really can step
  // backwards mid-transfer. On a single file that correction is worth showing;
  // on a batch of twelve it just makes the bar walk backwards, which reads as a
  // bug. The aggregate therefore only ever climbs.
  if (measured || size >= task.bytes) {
    task.bytes = isBatch(task) ? Math.max(size, task.bytes) : size
  }

  if (measured) {
    // The count arrives as a staircase: aria2c rewrites its bitmap once per
    // auto-save interval, so nothing changes for a whole minute and then the
    // whole minute lands in one step. Dividing that step by a short sampling
    // window produced a 1.2 GB step over 5 s — a 246 MB/s reading on a transfer
    // actually running at 30 MB/s. The step is therefore divided by the interval
    // it really covers, which is the time since the previous step.
    if (grew) {
      const since = task.lastGrowthAt || task.startedAt
      const span = now - since
      if (span >= MIN_SPEED_SPAN_MS) task.speed = ((size - previous) * 1000) / span
      task.lastGrowthAt = now
    } else if (!sidecarFresh) {
      // No step and the sidecar is stale: the transfer really has stopped.
      task.speed = 0
    }
    // …and while the sidecar is fresh with no step, the last rate is held: the
    // bytes are still arriving, aria2c just has not written them down yet.
    task.history.push({ t: now, s: size })
    if (task.history.length > SPEED_WINDOW) task.history.shift()
    return
  }

  task.history.push({ t: now, s: size })
  while (task.history.length > SPEED_WINDOW) task.history.shift()

  const first = task.history[0]
  const span = now - first.t
  if (span >= MIN_SPEED_SPAN_MS) {
    const delta = size - first.s
    if (delta > 0) task.speed = (delta * 1000) / span
    // A flat window is not proof of a stall. Some downloaders write through a
    // buffer, so the size holds for a few seconds while bytes are in flight.
    // Zeroing the rate there made a healthy download read as "0 B/s" — the most
    // alarming thing a progress card can show.
    else if (!sidecarFresh) task.speed = 0
  }
}
