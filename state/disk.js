/**
 * How many bytes are really on disk for a target.
 *
 * Two downloaders make `stat().size` lie, and each lie retired a healthy card:
 * aria2c preallocates the file (100 % from the first tick, so its `.aria2` bitmap
 * is the only truth) and git clone writes a *directory* (always 0 on Windows, so
 * the files underneath must be summed). Both measurements are bounded, because
 * they run once per second on the host's main thread.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CLONE_WALK_MAX_DEPTH, CLONE_WALK_MAX_ENTRIES } from './tuning.js'

/**
 * Bytes a downloader has actually written, read from aria2c's control file.
 *
 * aria2c preallocates the target to its final size before the first byte lands
 * (`FileAlloc 7.2 GiB/7.2 GiB`), so `stat().size` reports 100 % for the entire
 * transfer. The `.aria2` sidecar is the only truthful source: a big-endian
 * header plus a bitmap of completed 1 MiB pieces.
 *
 * Returns `undefined` when there is no control file, which means "this is not an
 * aria2c download in progress — trust stat()". Returns 0 for a control file we
 * cannot parse: the transfer is plainly still running (the sidecar only exists
 * mid-transfer), so 0 is far closer than the preallocated size.
 *
 * @param {string} target absolute path of the file being written
 * @returns {number | undefined} completed bytes
 */
export function aria2Completed(target) {
  let buf
  try {
    buf = readFileSync(`${target}.aria2`)
  } catch {
    return undefined
  }
  try {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let p = 2 // version
    p += 4 + dv.getUint32(p) // extLen + ext
    p += 4 + dv.getUint32(p) // infoHashLen + infoHash
    const pieceLen = dv.getUint32(p)
    const total = Number(dv.getBigUint64(p + 4))
    // p+12 is uploadLength (unused), p+20 is the bitfield length.
    const bfLen = dv.getUint32(p + 20)
    p += 24
    if (!pieceLen || !total || buf.length < p + bfLen) return 0
    const pieces = Math.ceil(total / pieceLen)
    let done = 0
    for (let i = 0; i < bfLen; i += 1) {
      const byte = buf[p + i]
      if (byte === 0) continue
      for (let k = 0; k < 8; k += 1) {
        if ((byte >> k) & 1) done += 1
      }
    }
    if (done >= pieces) return total
    return done * pieceLen
  } catch {
    return 0
  }
}

/**
 * Bytes currently on disk underneath a directory, bounded.
 *
 * `statSync(dir).size` is 0 for every directory on Windows, which is why a
 * `git clone` card could never move: the clone target *is* a directory, so the
 * sampler recorded 0 B forever and the idle counter retired the card seconds in.
 * Summing the files underneath is the only measurement that reflects what the
 * clone is actually doing.
 *
 * The walk is deliberately capped on both axes — a clone of a huge repository can
 * contain tens of thousands of entries, and this runs once per second on the host
 * main thread. Hitting a cap stops the sum where it is: an undercount that
 * settles, never a hang.
 *
 * @param {string} dir absolute directory path
 * @returns {number} total bytes of the regular files found
 */
export function directoryBytes(dir) {
  let total = 0
  let visited = 0
  /** @type {Array<[string, number]>} */
  const queue = [[dir, 0]]
  while (queue.length) {
    const [current, depth] = queue.shift()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      // A directory that vanished mid-walk (git replaces trees as it checks out)
      // simply contributes nothing; the next tick picks up the new tree.
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited > CLONE_WALK_MAX_ENTRIES) return total
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (depth < CLONE_WALK_MAX_DEPTH) queue.push([path, depth + 1])
        continue
      }
      // Symlinks and junctions are skipped on purpose: following them can leave
      // the clone entirely (or loop), and their own size is not bytes cloned.
      if (!entry.isFile()) continue
      try {
        total += statSync(path).size
      } catch {
        /* removed between readdir and stat */
      }
    }
  }
  return total
}
