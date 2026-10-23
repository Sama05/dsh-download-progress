/**
 * gen-background-split.mjs — one-shot generator: slices background.js into
 * background/*.js plus a barrel.
 *
 * Same method as the detect/state splits: cut by line range so every body stays
 * byte-identical, promote only the declarations that cross a module boundary,
 * then let the existing suite prove the wiring.
 *
 * Run once; afterwards background/ is the source of truth.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SRC = readFileSync(join(ROOT, 'background.js'), 'utf8').split('\n')
const at = (from, to) => SRC.slice(from - 1, to).join('\n')

/** [key, from, to, exports[], imports[]] */
const PARTS = [
  [
    'tuning',
    31,
    73,
    [
      'WAIT_TOOLS',
      'CONDITIONAL_WAIT',
      'SHELL_TOOLS',
      'FOREGROUND_GRACE_MS',
      'LINGER_MS',
      'RECONCILE_AFTER_MS',
      'MAX_ROWS',
    ],
    [],
  ],
  ['tables', 75, 104, ['jobs', 'subs', 'flows', 'activeTools', 'title'], []],
  ['jobs', 106, 158, ['jobStatus'], ["import { jobs } from './tables.js'"]],
  [
    'subagent',
    160,
    203,
    [],
    ["import { title, subs } from './tables.js'", "import { ownerOfRunning } from './tools.js'"],
  ],
  ['workflow', 205, 269, [], ["import { flows } from './tables.js'", "import { ownerOfRunning } from './tools.js'"]],
  ['tools', 271, 308, ['ownerOfRunning'], ["import { activeTools } from './tables.js'"]],
  [
    'waits',
    310,
    371,
    ['isForegroundJob', 'isWaitedOn'],
    [
      "import { activeTools } from './tables.js'",
      'import {',
      '  CONDITIONAL_WAIT,',
      '  FOREGROUND_GRACE_MS,',
      '  SHELL_TOOLS,',
      '  WAIT_TOOLS,',
      "} from './tuning.js'",
    ],
  ],
  [
    'snapshot',
    373,
    472,
    [],
    [
      'import { activeTools, flows, jobs, subs, title } from \'./tables.js\'',
      'import { jobStatus } from \'./jobs.js\'',
      'import { isForegroundJob, isWaitedOn } from \'./waits.js\'',
      'import { LINGER_MS, MAX_ROWS, RECONCILE_AFTER_MS } from \'./tuning.js\'',
    ],
  ],
]

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

const OUT = join(ROOT, 'background')
mkdirSync(OUT, { recursive: true })

const HEADER = `/**
 * background/${''}MODULE — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
`

const written = []
for (const [key, from, to, exports, imports] of PARTS) {
  const body = promote(at(from, to), exports).replace(/^\n+/, '').replace(/\n+$/, '')
  const head = HEADER.replace('MODULE', key + '.js') + (imports.length ? imports.join('\n') + '\n\n' : '')
  const text = head + body + '\n'
  writeFileSync(join(OUT, key + '.js'), text, 'utf8')
  written.push([key + '.js', body.split('\n').length])
}

const BARREL = `/**
 * background.js — what the agent is doing *besides* the transfer on screen.
 *
 * The overlay has always answered "how far along is this download". This module
 * answers a different question: "is anything else still running for this
 * session, and is the agent stuck waiting on it".
 *
 * Three producers, all optional, all observed read-only:
 *
 *   jobs        bash background jobs. \`jobs\` service events carry the owner
 *               session, a status and the progress line the producer wrote.
 *   subagent    \`subagent/start\` / \`subagent/end\`. The event carries the child
 *               session id but NOT the parent, so ownership is inferred from
 *               the parent that is currently blocked on the subagent tool.
 *   workflow    \`workflow/start\` / \`phase\` / \`log\` / \`end\`. Same shape of
 *               problem, same inference.
 *
 * Nothing here changes a dispatch decision and nothing throws outward: a host
 * without the jobs plugin, or an event with a shape this file does not know,
 * simply produces no background rows.
 *
 * ## "running" and "waiting" are not the same thing
 *
 * A job can be running while the agent happily does something else. Showing
 * "agent is waiting" then would be a lie. Waiting is only claimed when the
 * owning session's current tool call is one that blocks on background work —
 * see tuning.js. That state is read from \`tools/execute\`, which is blocked for
 * exactly as long as the tool is.
 *
 * ## Layout
 *
 * This file is a barrel: the implementation is \`background/*.js\`, one module
 * per concern, so no single file has to hold the whole bookkeeping model.
 */

export { RECONCILE_AFTER_MS } from './background/tuning.js'
export { setTitleLookup } from './background/tables.js'
export { noteJobEvent } from './background/jobs.js'
export { noteSubagentStart, noteSubagentEnd } from './background/subagent.js'
export {
  noteWorkflowStart,
  noteWorkflowPhase,
  noteWorkflowLog,
  noteWorkflowEnd,
} from './background/workflow.js'
export { noteToolStart, noteToolEnd } from './background/tools.js'
export { backgroundSnapshot, reconcileJobs, resetBackground } from './background/snapshot.js'
`
writeFileSync(join(ROOT, 'background.js'), BARREL, 'utf8')

console.log('wrote background.js barrel + background/ modules')
for (const [name, lines] of written) console.log(String(lines).padStart(5) + '  background/' + name)
