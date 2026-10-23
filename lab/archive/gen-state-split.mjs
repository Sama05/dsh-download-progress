/**
 * gen-state-split.mjs — one-shot generator: slices state.js into state/*.js.
 *
 * Same method as the detect split: cut by line range so every body stays
 * byte-identical, then let the existing test suite prove the wiring. The only
 * thing that can go wrong is a bad range or a missing import, and both fail
 * loudly.
 *
 * Run once; afterwards state/*.js is the source of truth and this file is deleted.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SRC = readFileSync(join(ROOT, 'state.js'), 'utf8').split('\n')

const at = (from, to) => SRC.slice(from - 1, to).join('\n')

const RANGES = {
  tuning: [[26, 80], [107, 158]],
  registry: [[82, 105], [160, 211], [577, 625]],
  aria2: [[213, 330]],
  probes: [[332, 437], [627, 722]],
  disk: [[724, 825]],
  begin: [[439, 575]],
  sample: [[827, 1015]],
  // 1017-1025 is a stale duplicate of the doc comment that follows it (the real
  // one starts at 1026). Dropping the orphan is the only byte that deliberately
  // does not survive the slice.
  sweep: [[1026, 1100]],
  snapshot: [[1102, 1219]],
}

function slice(parts) {
  return parts
    .map(([from, to]) => {
      const body = at(from, to)
      if (!body.trim()) throw new Error(`empty slice ${from}-${to}`)
      return body
    })
    .join('\n\n')
}

const PART = {}
for (const [key, ranges] of Object.entries(RANGES)) PART[key] = slice(ranges)

/** Add `export` to the declaration line only; body and doc comment untouched. */
function promote(body, names) {
  let out = body
  for (const name of names) {
    if (new RegExp(`^export (?:async )?(?:function|const|let) ${name}\\b`, 'm').test(out)) continue
    const patterns = [
      new RegExp(`^(?:async )?function ${name}\\(`, 'm'),
      new RegExp(`^(?:const|let) ${name} `, 'm'),
    ]
    let hit = false
    for (const re of patterns) {
      if (re.test(out)) {
        out = out.replace(re, (m) => `export ${m}`)
        hit = true
        break
      }
    }
    if (!hit) throw new Error(`promote: "${name}" not found as a top-level declaration`)
  }
  return out
}

const file = (header, imports, body) => {
  const lines = [header]
  if (imports.length > 0) lines.push('', ...imports)
  if (body.trim()) lines.push('', body)
  return lines.join('\n') + '\n'
}

const OUT = {
  'state/tuning.js': file(
    `/**
 * Every duration and cap the sampler obeys, in one place.
 *
 * These numbers are the plugin's whole theory of how long a download may take:
 * a card is retired here, kept alive here, and bounded here. Scattering them
 * through the sampler made "why did my card vanish" unanswerable, because the
 * answer depended on which of nine constants applied. Each one carries the bug
 * that set it.
 */`,
    [],
    promote(PART.tuning, [
      'IDLE_TICKS_TO_CLOSE',
      'LINGER_MS',
      'BUSY_GRACE_MS',
      'SPEED_WINDOW',
      'MIN_SPEED_SPAN_MS',
      'SIDECAR_FRESH_MS',
      'PREALLOC_QUIET_MS',
      'PREALLOC_GRACE_MS',
      'START_GRACE_MS',
      'MAX_TASK_MS',
      'MAX_GROWING_TASK_MS',
      'CLONE_WALK_MAX_ENTRIES',
      'CLONE_WALK_MAX_DEPTH',
    ]),
  ),

  'state/registry.js': file(
    `/**
 * The one task map, and the handles the rest of \`state/\` reads it through.
 *
 * Module state on purpose: one plugin instance owns one overlay, and the snapshot
 * route reads the same map the sampler writes. Kept in its own module so that
 * "who can mutate a card" has a single file to audit — everything else in the
 * folder takes the map from here rather than declaring its own.
 */`,
    [],
    promote(PART.registry, [
      'tasks',
      'sidecarsSeen',
      'isBatch',
      'titleResolver',
      'TITLE_TTL_MS',
      'setTitleResolver',
      'forEachTask',
      'BUILD_TAG',
      'findByTarget',
      'retarget',
    ]),
  ),

  'state/aria2.js': file(
    `/**
 * aria2c's \`-i\` manifest: reading it, and resolving it into real target paths.
 *
 * A manifest is the only way one command line can name dozens of files, so this
 * is the only place the plugin opens a file the *agent* chose. Every caps and
 * every "return null" below exists to make a hostile or merely huge manifest
 * degrade to the previous behaviour instead of stalling the sampler.
 */`,
    [
      `import { readFileSync, statSync } from 'node:fs'`,
      `import { isAbsolute, resolve } from 'node:path'`,
      `import { aria2InputSpec, commandWorkingDirectory } from '../detect.js'`,
    ],
    promote(PART.aria2, ['ARIA_INPUT_MAX_BYTES', 'ARIA_INPUT_MAX_ENTRIES']),
  ),

  'state/probes.js': file(
    `/**
 * HEAD probes for the denominator: one URL, or a whole batch.
 *
 * A card without a total shows an indeterminate ring, so this is what turns the
 * bar into a percentage. Both probes are fire-and-forget — \`beginTask\` starts
 * them and returns — which is exactly why each needs its own semaphore: nothing
 * upstream throttles a loop that issues two hundred curls.
 */`,
    [],
    promote(PART.probes, ['probeTotal', 'probeBulkTotal']),
  ),

  'state/disk.js': file(
    `/**
 * How many bytes are really on disk for a target.
 *
 * Two downloaders make \`stat().size\` lie, and each lie retired a healthy card:
 * aria2c preallocates the file (100 % from the first tick, so its \`.aria2\` bitmap
 * is the only truth) and git clone writes a *directory* (always 0 on Windows, so
 * the files underneath must be summed). Both measurements are bounded, because
 * they run once per second on the host's main thread.
 */`,
    [
      `import { readFileSync, readdirSync, statSync } from 'node:fs'`,
      `import { join } from 'node:path'`,
      `import { CLONE_WALK_MAX_DEPTH, CLONE_WALK_MAX_ENTRIES } from './tuning.js'`,
    ],
    promote(PART.disk, ['directoryBytes']),
  ),

  'state/begin.js': file(
    `/**
 * Turning one dispatch into one card.
 *
 * This is where a tool call becomes byte counts: which paths it will write, what
 * to call it, where its bytes come from, and whether an existing card should
 * adopt it as a retry. Everything here runs once, inside the tool-call waterfall,
 * so it must never throw and never block.
 */`,
    [
      `import { basename } from 'node:path'`,
      `import { PKG_RE, extractTargets, remoteFileName, runsAria2, runsGitClone } from '../detect.js'`,
      `import { scriptPlan } from '../script.js'`,
      `import { clip, extractUrl, firstLine, text } from '../utils.js'`,
      `import { readAria2Bulk } from './aria2.js'`,
      `import { probeBulkTotal, probeTotal } from './probes.js'`,
      `import { findByTarget, retarget, tasks } from './registry.js'`,
    ],
    promote(PART.begin, ['beginTask']),
  ),

  'state/sample.js': file(
    `/**
 * One sampling tick: measure the target, then turn the measurement into a rate.
 *
 * Deliberately separate from \`sweep.js\`, which decides *when* a card is retired.
 * This file only answers "how fast is it going right now", and most of its length
 * is the exceptions that answer would be wrong without: preallocation, a batch
 * whose sum may fall, a bitmap written once a minute, a flat window that is not a
 * stall.
 */`,
    [
      `import { statSync } from 'node:fs'`,
      `import { aria2Completed, directoryBytes } from './disk.js'`,
      `import { isBatch, sidecarsSeen } from './registry.js'`,
      `import {
  MIN_SPEED_SPAN_MS,
  PREALLOC_GRACE_MS,
  PREALLOC_QUIET_MS,
  SIDECAR_FRESH_MS,
  SPEED_WINDOW,
  START_GRACE_MS,
} from './tuning.js'`,
    ],
    promote(PART.sample, ['sample']),
  ),

  'state/sweep.js': file(
    `/**
 * Retiring cards, and the two install events that keep an install card current.
 *
 * A card may only leave once it is both finished *and* quiet, which is what keeps
 * a \`run_in_background\` download visible after its tool call returned. The whole
 * rule is here so there is one place to explain why a card disappeared.
 */`,
    [
      `import { clip, lastLine, text } from '../utils.js'`,
      `import { sample } from './sample.js'`,
      `import { forEachTask, tasks } from './registry.js'`,
      `import {
  BUSY_GRACE_MS,
  IDLE_TICKS_TO_CLOSE,
  LINGER_MS,
  MAX_GROWING_TASK_MS,
  MAX_TASK_MS,
} from './tuning.js'`,
    ],
    promote(PART.sweep, ['sweep', 'noteInstallLog', 'noteInstallPhase']),
  ),

  'state/snapshot.js': file(
    `/**
 * The wire format the Client half polls, and the two derivations it needs.
 *
 * Serialised once per second per client, so the shape is flat and small on
 * purpose. \`displayedBytes\` and \`refreshTitle\` live here because they exist only
 * to make that one payload honest: a bitmap-backed count that would otherwise
 * freeze for a minute, and a session title that did not exist yet at start.
 */`,
    [`import { text } from '../utils.js'`, `import { isBatch, tasks, titleResolver, TITLE_TTL_MS } from './registry.js'`],
    promote(PART.snapshot, ['fallbackSessionTitle', 'snapshot']),
  ),
}

mkdirSync(join(ROOT, 'state'), { recursive: true })
for (const [name, content] of Object.entries(OUT)) {
  writeFileSync(join(ROOT, name), content)
  console.log(`wrote ${name}  ${content.split('\n').length - 1} lines`)
}

const barrel = `/**
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
 *  aria2.js     the \`-i\` manifest: reading it, resolving it to real paths
 *  probes.js    HEAD probes that supply the denominator
 *  disk.js      bytes really on disk (aria2c bitmap, git clone tree)
 *  begin.js     one dispatch -> one card
 *  sample.js    one tick: measure the target, derive a rate
 *  sweep.js     retire finished cards; install events
 *  snapshot.js  the wire shape the Client polls
 *
 * This file re-exports the public surface, so every caller keeps importing
 * \`./state.js\`.
 */
export { BUILD_TAG, setTitleResolver } from './state/registry.js'
export { IDLE_TICKS_TO_CLOSE, LINGER_MS } from './state/tuning.js'
export { parseAria2Input, readAria2Bulk } from './state/aria2.js'
export { aria2Completed } from './state/disk.js'
export { beginTask } from './state/begin.js'
export { sweep, noteInstallLog, noteInstallPhase } from './state/sweep.js'
export { fallbackSessionTitle, snapshot } from './state/snapshot.js'
`
writeFileSync(join(ROOT, 'state.js'), barrel)
console.log(`wrote state.js  ${barrel.split('\n').length - 1} lines`)
