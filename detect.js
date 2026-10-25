/**
 * Tool-call recognition for the Host half.
 *
 * This file is the package's only public entry for recognition: it re-exports the
 * rules from `detect/` so every caller keeps importing `./detect.js` and nothing
 * outside the folder needs to know how it is divided.
 *
 * The division, in dependency order (each layer imports only the layers above it,
 * so the graph is acyclic and `import/no-cycle` has nothing to report):
 *
 *  tools.js        which tool names mean search / fetch / shell
 *  patterns.js     the flag regexes, the token readers, and the head-program tests
 *  spec.js         the transfer catalogue: one row per program that writes a file
 *  segments.js     where one command ends and the next begins
 *  vars.js         plain assignments, and the cwd a command really runs in
 *  remote.js       the name a URL asks to be saved as
 *  targets.js      the paths a command will write to
 *  downloaders.js  aria2c and git, the two non-flag-shaped downloaders
 *  classify.js     the decision itself
 *
 * What this barrel is FOR: a boundary. `state/` (the card layer) may import this
 * file and nothing inside `detect/`, which is what stops a new downloader's
 * syntax from reaching into bookkeeping. `architecture.mjs` enforces it. Anything
 * exported here is a promise; anything not exported is private to the folder.
 *
 * `plan/expand.js` sits above this barrel and below `state/`: it combines what
 * `classify()` decided with what `script.js` can read out of a `-File` script, so
 * the card layer receives concrete paths and never parses a command itself.
 */
export { FETCH_TOOLS, SEARCH_TOOLS, SHELL_TOOLS } from './detect/tools.js'
export { GIT_CLONE_RE, PKG_RE, PS_OUTFILE_RE, PS_SCRIPT_FILE_RE } from './detect/patterns.js'
export { commandSegments } from './detect/segments.js'
export { transferIsStaged } from './detect/spec.js'
export { commandWorkingDirectory } from './detect/vars.js'
export { remoteFileName } from './detect/remote.js'
export { extractTargets } from './detect/targets.js'
export { aria2InputSpec, runsAria2, runsGitClone } from './detect/downloaders.js'
export { classify } from './detect/classify.js'
