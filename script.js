/**
 * Static resolution of a `-File` script's download target.
 *
 * Why this exists
 * ---------------
 * `detect.js` reads the *command line*. That misses
 * `powershell -File get-iso.ps1` completely: the head program is powershell, no
 * downloader name appears, no `-OutFile` appears, so `classify()` returns null
 * and no card is ever created.
 *
 * Three ways to fix that were measured on this machine, and two failed:
 *
 *   per-process IO counters  — `Win32_Process.ReadTransferCount` counts FILE I/O
 *                              only. A 12 MiB download moved it by 0 bytes.
 *   TCP extended statistics  — `SetPerTcpConnectionEStats` returns 5
 *                              (ACCESS_DENIED) for a non-elevated process, and the
 *                              read then yields uninitialised memory.
 *   reading the script       — works, needs no privileges, costs ~0.4 ms.
 *
 * Getting the child's PID is not an option either: the `tools/execute` hook
 * exposes no pid, the tool result schema has none, and the subprocess handle is
 * provider-private by design. So the script is the only honest source.
 *
 * Once a path is known, the existing 1 Hz `stat()` sampler in `state.js` does the
 * rest — a child `curl.exe` writing that same file is sampled identically, which
 * is why this module only has to answer "which file?".
 *
 * Deliberate limits
 * -----------------
 * Only single-level literals are resolved. Anything that would require running
 * the script (a path built from `Get-Content`, a `+` concatenation, a here-string,
 * a `$(...)` subexpression) returns nothing. That is the same promise `detect.js`
 * already makes for command lines: an honest "unresolved" beats a wrong path,
 * because a wrong path produces a card that samples a file that never exists and
 * sits at 0 % forever.
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * This file is a barrel: the implementation is `script/*.js`, one module per
 * step of the pipeline (comments → variables → target scan → file read → plan),
 * so no single file has to hold the whole resolver.
 */

export { MAX_SCRIPT_BYTES } from './script/tuning.js'
export { stripComments } from './script/comments.js'
export { collectAssignments, resolveValue } from './script/vars.js'
export { scriptTargets, scriptUrls } from './script/targets.js'
export { decodeScript, scriptPathOf, readScript } from './script/read.js'
export { scriptPlan, scriptFileTargets } from './script/plan.js'
