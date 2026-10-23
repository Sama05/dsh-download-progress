/**
 * gen-script-split.mjs — one-shot generator: slices script.js into script/*.js
 * plus a barrel.
 *
 * Same method as the detect/state/background splits: cut by line range so every
 * body stays byte-identical, promote only the declarations that cross a module
 * boundary, then let the existing suite prove the wiring.
 *
 * Run once; afterwards script/ is the source of truth.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SRC = readFileSync(join(ROOT, 'script.js'), 'utf8').split('\n')
const at = (from, to) => SRC.slice(from - 1, to).join('\n')

/** [key, from, to, exports[], imports[]] */
const PARTS = [
  [
    'tuning',
    40,
    56,
    ['MAX_SCRIPT_BYTES', 'MAX_DEPTH', 'OUT_FLAG_RE', 'FILE_FLAG_RE'],
    [],
  ],
  ['comments', 58, 122, ['stripComments'], []],
  [
    'vars',
    124,
    243,
    ['collectAssignments', 'resolveValue'],
    ["import { MAX_DEPTH } from './tuning.js'"],
  ],
  [
    'targets',
    245,
    298,
    ['scriptTargets', 'scriptUrls'],
    [
      "import { OUT_FLAG_RE } from './tuning.js'",
      "import { collectAssignments, resolveValue } from './vars.js'",
      "import { stripComments } from './comments.js'",
    ],
  ],
  [
    'read',
    300,
    363,
    ['decodeScript', 'scriptPathOf', 'readScript'],
    [
      "import { readFileSync, statSync } from 'node:fs'",
      "import path from 'node:path'",
      'import {',
      '  MAX_SCRIPT_BYTES,',
      '  FILE_FLAG_RE,',
      "} from './tuning.js'",
    ],
  ],
  [
    'plan',
    365,
    406,
    ['scriptPlan', 'scriptFileTargets'],
    [
      "import { readScript } from './read.js'",
      "import { scriptTargets, scriptUrls } from './targets.js'",
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

const OUT = join(ROOT, 'script')
mkdirSync(OUT, { recursive: true })

const written = []
for (const [key, from, to, exports, imports] of PARTS) {
  const body = promote(at(from, to), exports).replace(/^\n+/, '').replace(/\n+$/, '')
  const header = imports.length ? imports.join('\n') + '\n\n' : ''
  writeFileSync(join(OUT, key + '.js'), header + body + '\n', 'utf8')
  written.push([key + '.js', body.split('\n').length])
}

const ORIGINAL_HEAD = at(1, 38)

const BARREL =
  ORIGINAL_HEAD.replace(
    /\nimport \{ readFileSync, statSync \} from 'node:fs'\nimport path from 'node:path'\n/,
    '\n',
  ) +
  `

/**
 * This file is a barrel: the implementation is \`script/*.js\`, one module per
 * step of the pipeline (comments → variables → target scan → file read → plan),
 * so no single file has to hold the whole resolver.
 */

export { MAX_SCRIPT_BYTES } from './script/tuning.js'
export { stripComments } from './script/comments.js'
export { collectAssignments, resolveValue } from './script/vars.js'
export { scriptTargets, scriptUrls } from './script/targets.js'
export { decodeScript, scriptPathOf, readScript } from './script/read.js'
export { scriptPlan, scriptFileTargets } from './script/plan.js'
`
writeFileSync(join(ROOT, 'script.js'), BARREL, 'utf8')

console.log('wrote script.js barrel + script/ modules')
for (const [name, lines] of written) console.log(String(lines).padStart(5) + '  script/' + name)
