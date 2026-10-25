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
 *  probes.js    HEAD probes that supply the denominator
 *  disk.js      bytes really on disk (aria2c bitmap, git clone tree)
 *  begin.js     one plan -> one card
 *  sample.js    one tick: measure the target, derive a rate
 *  sweep.js     retire finished cards; install events
 *  snapshot.js  the wire shape the Client polls
 *
 * This folder may import `detect.js` (the public barrel) and nothing inside
 * `detect/` or `script/` — see `architecture.mjs`. Everything it needs to know
 * about a command has already been resolved into a plan by `plan/expand.js`,
 * which is re-exported below because the manifest reader moved there with it.
 *
 * This file re-exports the public surface, so every caller keeps importing
 * `./state.js`.
 */
export { BUILD_TAG, setTitleResolver } from './state/registry.js'
export { IDLE_TICKS_TO_CLOSE, LINGER_MS } from './state/tuning.js'
export { expandPlan, parseAria2Input, readAria2Bulk } from './plan.js'
export { aria2Completed } from './state/disk.js'
export { beginTask } from './state/begin.js'
export { sweep, noteInstallLog, noteInstallPhase } from './state/sweep.js'
export { fallbackSessionTitle, snapshot } from './state/snapshot.js'
