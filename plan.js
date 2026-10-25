/**
 * A dispatch -> the concrete files it will write.
 *
 * Why this layer exists
 * ---------------------
 * `detect` reads the command line; `script` reads a script the command line
 * names. Both answer "which paths?", from different evidence, and neither can do
 * it alone: the destination of `powershell -File get-iso.ps1` is only inside the
 * script, while `curl -o x.iso` is only on the command line.
 *
 * Joining them used to happen inside `state/begin.js`, which meant the card layer
 * imported two recognition layers directly. That is the wrong direction —
 * bookkeeping started depending on parsing, so a new downloader's syntax changed
 * the sampler's imports. This layer owns the join instead: it may read both, it
 * returns plain data, and `state` sees only concrete paths.
 *
 * `architecture.mjs` enforces the direction. This is also a barrel: `aria2.js`
 * (the `-i` manifest) and `expand.js` (the join itself) are the two halves.
 */
export {
  ARIA_INPUT_MAX_BYTES,
  ARIA_INPUT_MAX_ENTRIES,
  parseAria2Input,
  readAria2Bulk,
} from './plan/aria2.js'
export { expandPlan } from './plan/expand.js'
