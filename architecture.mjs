/**
 * Architecture test: the Host half's import graph, enforced by machine.
 *
 * Why this file exists
 * --------------------
 * "Which module may this file import?" is a design decision a reviewer catches
 * once and a hundred later commits quietly undo. This plugin is meant to keep
 * growing — a new downloader, a new recognised tool, a new background source —
 * and every one of those additions is an invitation to reach across a boundary
 * because it is only one import away. A comment cannot stop that; a failing test
 * can.
 *
 * The layering it enforces, bottom to top:
 *
 *   utils       plain functions over strings. Imports nothing. Anything may use it.
 *   script      a `-File` script -> targets and URLs. Reads files, builds no plan.
 *   detect      a dispatch -> a plan that names the concrete files. May use
 *               `script`; this is the only layer that may, so "the destination
 *               lives inside a file" stays one adapter instead of leaking into
 *               every caller.
 *   plan        the join of the two above: command line + script -> the concrete
 *               targets, URL, downloader flags and title one card needs. May use
 *               both recognition layers because that is exactly its job; returns
 *               plain data and owns no state.
 *   state       a plan -> a card, and the card's life. Reaches `detect` through
 *               its public barrel `detect.js` ONLY, never into `detect/` and
 *               never into `script/`. Everything else it would need has already
 *               been resolved by `plan/`, which is why adding a downloader never
 *               edits the sampler.
 *   background  jobs/subagents/workflows. Self-contained on purpose: it shares
 *               the wire shape, not the code.
 *
 * `index.js` (wiring) and `utils.js` (kernel) are exempt: the first sits above
 * every layer by definition, the second below every one of them.
 *
 * The barrel rule is the load-bearing one. `state/begin.js` used to import
 * `detect/patterns.js` symbols directly, which meant a change to how targets are
 * parsed could silently alter how a card is born. Now the barrel is the seam: a
 * name is either exported there (public, promised) or it is not (private).
 *
 * Run with `node architecture.mjs`; it is part of `npm test`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * What each layer may import, as package-root-relative specifiers.
 *
 * Written as data rather than as a check per layer because the value of this
 * test is the assertion, not the code: adding a layer must be a one-line edit
 * here that a reviewer can read, and the failure message below quotes the
 * allow-list verbatim so the fix is obvious from the terminal.
 *
 * A bare `detect.js` is the barrel; `detect/` is its private interior. Listing
 * them separately is what makes "public surface only" expressible at all.
 */
const ALLOWED = {
  utils: [],
  script: ['utils.js', 'script.js', 'script/'],
  detect: ['utils.js', 'script.js', 'detect.js', 'detect/', 'script/'],
  plan: ['utils.js', 'detect.js', 'script.js', 'plan.js', 'plan/'],
  state: ['utils.js', 'detect.js', 'plan.js', 'plan/', 'state.js', 'state/'],
  background: ['utils.js', 'background.js', 'background/'],
}

/** Every file belonging to a checked layer, as package-root-relative paths. */
function sourceFiles() {
  const out = []
  const addTree = (dir) => {
    let entries
    try {
      entries = readdirSync(join(HERE, dir))
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = `${dir}/${entry}`
      let stat
      try {
        stat = statSync(join(HERE, dir, entry))
      } catch {
        continue
      }
      if (stat.isDirectory()) addTree(rel)
      else if (entry.endsWith('.js')) out.push(rel)
    }
  }
  for (const layer of Object.keys(ALLOWED)) {
    addTree(layer)
    if (layer !== 'utils') out.push(`${layer}.js`)
  }
  return out.sort()
}

/**
 * The layer a package-root-relative path belongs to, or null when it is exempt.
 *
 * `state.js` and `state/begin.js` must both come out as `state`, so the rule is
 * the first path segment with its `.js` suffix removed.
 */
function layerOf(rel) {
  const name = rel.split('/')[0].replace(/\.js$/, '')
  return Object.prototype.hasOwnProperty.call(ALLOWED, name) ? name : null
}

/**
 * Every relative import specifier in one file.
 *
 * Deliberately matches only static ESM: a `require()` or a dynamic `import()`
 * would be a deliberate escape hatch and belongs in review, not in a regex that
 * silently grandfathers it in.
 *
 * @param {string} body
 * @returns {string[]}
 */
function importSpecs(body) {
  const specs = []
  const re = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g
  let match
  while ((match = re.exec(body)) !== null) {
    const spec = match[1] || match[2]
    if (spec && spec.startsWith('.')) specs.push(spec)
  }
  return specs
}

const violations = []
const files = sourceFiles()

for (const rel of files) {
  const self = layerOf(rel)
  if (!self) continue
  let body
  try {
    body = readFileSync(join(HERE, rel), 'utf8')
  } catch {
    continue
  }
  for (const spec of importSpecs(body)) {
    // Resolve against the importing file, then normalise to the package root so
    // `../utils.js` from `state/` and `./utils.js` from `detect/` compare equal.
    const target = posix.normalize(posix.join(posix.dirname(rel), spec))
    const allowed = ALLOWED[self]
    const ok = allowed.some((prefix) =>
      prefix.endsWith('/') ? target.startsWith(prefix) : target === prefix,
    )
    if (ok) continue
    violations.push({ from: rel, spec, target, layer: self, allowed })
  }
}

console.log('\narchitecture')

if (violations.length) {
  for (const v of violations) {
    console.log(`  FAIL ${v.from} imports ${v.target}`)
    console.log(
      `       the ${v.layer} layer may import only: ${v.allowed.join(', ') || '(nothing)'}`,
    )
  }
  console.log(`\n  ${violations.length} boundary violation(s)`)
  process.exit(1)
}

console.log(`  ok   ${files.length} files respect the layer boundaries`)
console.log('\nOK architecture')
