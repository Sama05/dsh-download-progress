/**
 * gen-detect-split.mjs — one-shot generator: slices detect.js into detect/*.js.
 *
 * Slicing by line range (not retyping) is the point: the bodies stay byte-identical,
 * so a refactor bug can only come from a wrong range or a wrong import list, and the
 * test suite catches both immediately.
 *
 * Run once; afterwards the generated files are the source of truth and this script
 * is deleted. (Keeping it around would invite someone to re-run it over edited files
 * and silently discard their work.)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SRC = readFileSync(join(ROOT, 'detect.js'), 'utf8').split('\n')

/** Inclusive 1-based line range → text. */
const at = (from, to) => SRC.slice(from - 1, to).join('\n')

const RANGES = {
  tools: [16, 32],
  splitRes: [38, 56],
  head: [58, 83],
  dl: [85, 104],
  runsAria2: [106, 123],
  runsGitClone: [125, 136],
  aria2InputSpec: [138, 159],
  runsIWR: [161, 165],
  expandLauncher: [167, 198],
  commandSegments: [200, 221],
  herestrings: [223, 256],
  splitTopLevel: [258, 310],
  inlineShellBody: [312, 328],
  isGitClone: [330, 340],
  psOutfile: [342, 343],
  psScriptFile: [345, 362],
  scriptHosts: [364, 365],
  runsScriptFile: [367, 375],
  gitClonePkg: [377, 386],
  maxScan: [388, 395],
  tables: [397, 457],
  flagValues: [459, 476],
  psArrayTokens: [478, 496],
  argListTargets: [498, 519],
  remoteFileName: [521, 548],
  decodeUrlName: [550, 569],
  collectAssignments: [571, 590],
  resolveVar: [592, 607],
  effectiveCwd: [609, 643],
  commandWorkingDirectory: [645, 660],
  extractTargets: [662, 811],
  searchQuery: [813, 841],
  classify: [843, 928],
}

const PART = {}
for (const [key, [from, to]] of Object.entries(RANGES)) {
  const body = at(from, to)
  if (!body.trim()) throw new Error(`part "${key}" sliced empty (${from}-${to})`)
  PART[key] = body
}

/**
 * Promote `function X(` / `const X =` to exported form.
 *
 * Done by rewriting the declaration line only, so the doc comment above it and the
 * body below it stay untouched. A name that does not appear is a generator bug and
 * throws rather than silently producing an unimportable symbol.
 */
function promote(body, names) {
  let out = body
  for (const name of names) {
    // Already-exported declarations (`export const PKG_RE = …`) are left alone;
    // the slice keeps whatever prefix the original line carried.
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

/** Assemble one module: header, imports, blank line, then each body. */
const file = (header, imports, bodies) => {
  const lines = [header]
  if (imports.length > 0) lines.push('', ...imports)
  for (const body of bodies) lines.push('', body)
  return lines.join('\n') + '\n'
}

const OUT = {
  'detect/tools.js': file(
    `/**
 * Which tools mean what.
 *
 * Three name sets and nothing else: they are the vocabulary the rest of
 * \`detect/\` reads, so they live alone where a reviewer can check the whole list
 * against the Harness's tool catalogue in one glance.
 */`,
    [],
    [PART.tools],
  ),

  'detect/patterns.js': file(
    `/**
 * Command-line patterns, and the two token readers built on them.
 *
 * Pure data: every regex here is matched against a command-line string, so this
 * module has no imports at all. Keeping them together is deliberate — the flags
 * are the plugin's entire knowledge of curl/wget/aria2c/PowerShell syntax, and a
 * rule read out of context is how \`-O\` and \`-o\` got swapped in the first place.
 */`,
    [],
    [
      promote(PART.psOutfile, ['PS_OUTFILE_RE']),
      promote(PART.psScriptFile, ['PS_SCRIPT_FILE_RE']),
      promote(PART.gitClonePkg, ['GIT_CLONE_RE', 'PKG_RE']),
      promote(PART.maxScan, ['MAX_SCAN_CHARS']),
      promote(PART.tables, [
        'CURL_OUTFILE_RE',
        'PS_OUTFILE_ARG_RE',
        'CURL_REMOTE_NAME_RE',
        'CURL_UPLOAD_RE',
        'WGET_OUTFILE_RE',
        'ARIA_OUTFILE_RE',
        'ARIA_DIR_RE',
        'ARIA_INPUT_RE',
        'OUTFILE_FLAGS',
        'ARG_LIST_RE',
      ]),
      promote(PART.flagValues, ['flagValues']),
      promote(PART.psArrayTokens, ['psArrayTokens']),
    ],
  ),

  'detect/programs.js': file(
    `/**
 * "Which program is this segment running?" — the tests that answer it.
 *
 * Every predicate here is a head test: a downloader only counts when it is the
 * thing being invoked, never when it is mentioned inside a string, a comment or
 * another command's argument.
 */`,
    [`import { CURL_UPLOAD_RE, PS_SCRIPT_FILE_RE } from './patterns.js'`],
    [
      promote(PART.head, ['headProgram']),
      promote(PART.dl, ['DOWNLOADER_NAMES', 'runsDownloader', 'runsCurlUpload']),
      promote(PART.runsIWR, ['runsInvokeWebRequest']),
      promote(PART.isGitClone, ['isGitClone']),
      promote(PART.scriptHosts, ['SCRIPT_HOSTS']),
      promote(PART.runsScriptFile, ['runsScriptFile']),
    ],
  ),

  'detect/segments.js': file(
    `/**
 * Splitting a command line into the pieces that could each be an invocation.
 *
 * This is the module the rest of \`detect/\` depends on, and the one that must not
 * grow a second job: it finds where a command *starts*; nothing here decides
 * whether a command is interesting.
 */`,
    [
      `import { text } from '../utils.js'`,
      `import { ARG_LIST_RE, psArrayTokens } from './patterns.js'`,
      `import { headProgram } from './programs.js'`,
    ],
    [
      PART.splitRes,
      promote(PART.expandLauncher, ['expandLauncher']),
      promote(PART.commandSegments, ['commandSegments']),
      promote(PART.herestrings, ['stripHereStrings']),
      promote(PART.splitTopLevel, ['splitTopLevel']),
      promote(PART.inlineShellBody, ['inlineShellBody']),
    ],
  ),

  'detect/vars.js': file(
    `/**
 * Plain variable assignments, and the working directory a command runs in.
 *
 * Both answer "what does this path actually mean", which is why they sit between
 * the splitter and the target extractor rather than inside either. Only a single
 * quoted or bare literal is ever resolved; anything computed stays unknown on
 * purpose, because a guessed path is a card that watches nothing.
 */`,
    [
      `import { isAbsolute, resolve } from 'node:path'`,
      `import { text, unquote } from '../utils.js'`,
      `import { commandSegments } from './segments.js'`,
    ],
    [
      promote(PART.collectAssignments, ['collectAssignments']),
      promote(PART.resolveVar, ['resolveVar']),
      promote(PART.effectiveCwd, ['effectiveCwd']),
      promote(PART.commandWorkingDirectory, ['commandWorkingDirectory']),
    ],
  ),

  'detect/remote.js': file(
    `/**
 * The name a URL asks to be saved as.
 *
 * Separate from \`targets.js\` because it answers the *label* question ("what am I
 * downloading") as well as the destination one, and because the two downloaders
 * disagree: aria2c percent-decodes the last segment before using it as a file
 * name, and curl \`-O\` does not.
 */`,
    [`import { basename } from 'node:path'`, `import { extractUrl } from '../utils.js'`],
    [promote(PART.remoteFileName, ['remoteFileName']), promote(PART.decodeUrlName, ['decodeUrlName'])],
  ),

  'detect/targets.js': file(
    `/**
 * Filesystem paths a shell command is going to write to.
 *
 * The one path-shaped question in \`detect/\`, and still a pure function of the
 * command string plus a cwd: it resolves, it never stats. Anything it cannot
 * resolve is dropped rather than guessed — a card on a path that never exists
 * stays at 0 % and reads as a broken plugin.
 */`,
    [
      `import { basename, isAbsolute, resolve } from 'node:path'`,
      `import { extractUrl, text, uniq, unquote } from '../utils.js'`,
      `import { commandSegments } from './segments.js'`,
      `import { collectAssignments, effectiveCwd, resolveVar } from './vars.js'`,
      `import { headProgram } from './programs.js'`,
      `import {
  ARG_LIST_RE,
  ARIA_DIR_RE,
  ARIA_OUTFILE_RE,
  CURL_OUTFILE_RE,
  CURL_REMOTE_NAME_RE,
  GIT_CLONE_RE,
  OUTFILE_FLAGS,
  PS_OUTFILE_ARG_RE,
  WGET_OUTFILE_RE,
  flagValues,
  psArrayTokens,
} from './patterns.js'`,
      `import { decodeUrlName, remoteFileName } from './remote.js'`,
    ],
    [promote(PART.argListTargets, ['argListTargets']), promote(PART.extractTargets, ['extractTargets'])],
  ),

  'detect/downloaders.js': file(
    `/**
 * aria2c and git — the two downloaders that are not "one flag names one file".
 *
 * aria2c preallocates its target, writes relative to \`-d\`, and can keep every real
 * target inside an \`-i\` manifest; git clone writes a directory tree that
 * \`stat().size\` cannot measure. Both exceptions are answered here, once, instead
 * of being re-derived in \`state.js\`.
 */`,
    [
      `import { text, unquote } from '../utils.js'`,
      `import { commandSegments } from './segments.js'`,
      `import { headProgram, isGitClone } from './programs.js'`,
      `import { collectAssignments, resolveVar } from './vars.js'`,
      `import { ARIA_DIR_RE, ARIA_INPUT_RE, flagValues } from './patterns.js'`,
    ],
    [
      promote(PART.runsAria2, ['runsAria2']),
      promote(PART.runsGitClone, ['runsGitClone']),
      promote(PART.aria2InputSpec, ['aria2InputSpec']),
    ],
  ),

  'detect/classify.js': file(
    `/**
 * The decision: does this dispatch deserve a card, and which shape does it take?
 *
 * Kept last in the dependency order on purpose — it is the only module that reads
 * every other rule at once, so policy changes have exactly one place to land.
 */`,
    [
      `import { clip, text } from '../utils.js'`,
      `import { FETCH_TOOLS, SEARCH_TOOLS, SHELL_TOOLS } from './tools.js'`,
      `import { MAX_SCAN_CHARS, PKG_RE, PS_OUTFILE_RE } from './patterns.js'`,
      `import { commandSegments } from './segments.js'`,
      `import {
  isGitClone,
  runsCurlUpload,
  runsDownloader,
  runsInvokeWebRequest,
  runsScriptFile,
} from './programs.js'`,
    ],
    [promote(PART.searchQuery, ['searchQuery']), promote(PART.classify, ['classify'])],
  ),
}

mkdirSync(join(ROOT, 'detect'), { recursive: true })
for (const [name, content] of Object.entries(OUT)) {
  writeFileSync(join(ROOT, name), content)
  console.log(`wrote ${name}  ${content.split('\n').length - 1} lines`)
}

const barrel = `/**
 * Tool-call recognition for the Host half.
 *
 * This file is the package's only public entry for recognition: it re-exports the
 * rules from \`detect/\` so every caller keeps importing \`./detect.js\` and nothing
 * outside the folder needs to know how it is divided.
 *
 * The division, in dependency order (each layer imports only the layers above it,
 * so the graph is acyclic and \`import/no-cycle\` has nothing to report):
 *
 *  tools.js        which tool names mean search / fetch / shell
 *  patterns.js     the flag regexes, and the two token readers built on them
 *  programs.js     "which program is this segment running?"
 *  segments.js     where one command ends and the next begins
 *  vars.js         plain assignments, and the cwd a command really runs in
 *  remote.js       the name a URL asks to be saved as
 *  targets.js      the paths a command will write to
 *  downloaders.js  aria2c and git, the two non-flag-shaped downloaders
 *  classify.js     the decision itself
 */
export { FETCH_TOOLS, SEARCH_TOOLS, SHELL_TOOLS } from './detect/tools.js'
export { GIT_CLONE_RE, PKG_RE, PS_OUTFILE_RE, PS_SCRIPT_FILE_RE } from './detect/patterns.js'
export { commandSegments } from './detect/segments.js'
export { commandWorkingDirectory } from './detect/vars.js'
export { remoteFileName } from './detect/remote.js'
export { extractTargets } from './detect/targets.js'
export { aria2InputSpec, runsAria2, runsGitClone } from './detect/downloaders.js'
export { classify } from './detect/classify.js'
`
writeFileSync(join(ROOT, 'detect.js'), barrel)
console.log(`wrote detect.js  ${barrel.split('\n').length - 1} lines`)
