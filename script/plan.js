import { readScript } from './read.js'
import { scriptTargets, scriptUrls } from './targets.js'
import { stripComments } from './comments.js'
import { STAGED_PROGRAM_RE } from './tuning.js'

/**
 * Everything the host can learn from a `-File` command without running it.
 *
 * This is the function the plugin calls. It never throws: it runs inside a hook
 * that must not disturb the tool call it observes, so every failure — a missing
 * file, a directory passed as `-File`, a binary, an oversized script — collapses
 * to `null` and the dispatch simply gets no card.
 *
 * @param {string} command the shell tool's command string
 * @param {string} [cwd] the agent working directory
 * @param {Record<string, string>} [env] defaults to `process.env`
 * @returns {{ scriptPath: string, targets: string[], urls: string[], staged: boolean } | null}
 */
export function scriptPlan(command, cwd, env = process.env) {
  try {
    const script = readScript(command, cwd)
    if (!script) return null
    const targets = scriptTargets(script.body, env)
    // No destination means this is not a download script after all. Reporting a
    // card anyway would put a permanent 0 % block on screen for, say, a script
    // that only prints something.
    if (targets.length === 0) return null
    // The command line is `powershell -File x.ps1`: it names no downloader, so
    // the transfer registry only sees the shell. Whether the bytes land on the
    // destination gradually or in one rename is decided inside the script.
    const staged = STAGED_PROGRAM_RE.test(stripComments(script.body))
    return { scriptPath: script.path, targets, urls: scriptUrls(script.body), staged }
  } catch {
    return null
  }
}

/**
 * Target paths contributed by a `-File` script, or `[]`.
 *
 * Kept as its own export because it is the readable form for tests and callers
 * that only want the paths.
 *
 * @param {string} command
 * @param {string} [cwd]
 * @param {Record<string, string>} [env]
 * @returns {string[]}
 */
export function scriptFileTargets(command, cwd, env = process.env) {
  return scriptPlan(command, cwd, env)?.targets ?? []
}
