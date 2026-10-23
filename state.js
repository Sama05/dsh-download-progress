/**
 * Task bookkeeping for the Host half.
 *
 * DSH notifies a plugin exactly twice per tool call (start and end), so there is
 * no progress stream to subscribe to. This folder therefore *derives* progress: a
 * 1 s sampler stats the file a command is writing and turns "bytes on disk" into a
 * byte count plus a rate.
 *
 * The division, in dependency order (each layer imports only the layers above it,
 * so the graph stays acyclic):
 *
 *  tuning.js    every duration and cap, each with the bug that set it
 *  registry.js  the task map, and the handles everything else reads it through
 *  aria2.js     the `-i` manifest: reading it, resolving it to real paths
 *  probes.js    HEAD probes that supply the denominator
 *  disk.js      bytes really on disk (aria2c bitmap, git clone tree)
 *  begin.js     one dispatch -> one card
 *  sample.js    one tick: measure the target, derive a rate
 *  sweep.js     retire finished cards; install events
 *  snapshot.js  the wire shape the Client polls
 *
 * This file re-exports the public surface, so every caller keeps importing
 * `./state.js`.
 */
export { BUILD_TAG, setTitleResolver } from './state/registry.js'
export { IDLE_TICKS_TO_CLOSE, LINGER_MS } from './state/tuning.js'
export { parseAria2Input, readAria2Bulk } from './state/aria2.js'
export { aria2Completed } from './state/disk.js'
export { beginTask } from './state/begin.js'
export { sweep, noteInstallLog, noteInstallPhase } from './state/sweep.js'
export { fallbackSessionTitle, snapshot } from './state/snapshot.js'
