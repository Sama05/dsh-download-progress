/**
 * aria2c's `-i` manifest: reading it, and resolving it into real target paths.
 *
 * A manifest is the only way one command line can name dozens of files, so this
 * is the only place the plugin opens a file the *agent* chose. Every caps and
 * every "return null" below exists to make a hostile or merely huge manifest
 * degrade to the previous behaviour instead of stalling the sampler.
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { aria2InputSpec, commandWorkingDirectory } from '../detect.js'

/**
 * Largest `-i` manifest we are willing to read, and how many entries we keep.
 *
 * The manifest is attacker-influenced only in the sense that an agent can point
 * aria2c at any file; reading a multi-gigabyte "list" or a file with a million
 * lines would stall the sampler. Past either cap the card degrades to the
 * single-target behaviour instead of hanging.
 */
export const ARIA_INPUT_MAX_BYTES = 4 * 1024 * 1024
export const ARIA_INPUT_MAX_ENTRIES = 5000

/** The file name aria2c would derive from a URL, percent-decoded. */
function aria2EntryName(url) {
  try {
    const path = new URL(url).pathname
    const last = path.slice(path.lastIndexOf('/') + 1)
    return last ? decodeURIComponent(last) : ''
  } catch {
    return ''
  }
}

/**
 * Parse an aria2c input file into `{ url, out, dir }` entries.
 *
 * The format is line-oriented: an unindented line starts a new entry and holds
 * its URI; indented `key=value` lines are that entry's options, optionally
 * comma-separated (`out=a.iso,dir=C:\x`). Blank lines and `#` comments are
 * skipped, exactly as aria2c does.
 *
 * @param {string} body
 * @returns {{ url: string, out: string, dir: string }[]}
 */
export function parseAria2Input(body) {
  const entries = []
  let current = null
  for (const rawLine of String(body ?? '').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    if (!/^\s/.test(rawLine)) {
      current = { url: rawLine.trim(), out: '', dir: '' }
      entries.push(current)
      continue
    }
    if (!current) continue
    for (const part of rawLine.trim().split(',')) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      const key = part.slice(0, eq).trim().toLowerCase()
      const value = part.slice(eq + 1).trim()
      if (key === 'out') current.out = value
      else if (key === 'dir') current.dir = value
    }
  }
  return entries
}

/**
 * Resolve `aria2c -i list.txt` into the concrete files it will write.
 *
 * Returns null — meaning "fall back to the ordinary command-line parsing" —
 * whenever anything is ambiguous: an unreadable manifest, a relative path with
 * no working directory, or a manifest that names no http(s) URI. Guessing here
 * is what makes a card silently watch nothing, so every uncertainty degrades to
 * the previous behaviour instead.
 *
 * @param {string} command
 * @param {string} cwd resolved agent working directory
 * @returns {{ targets: string[], urls: string[], listPath: string } | null}
 */
export function readAria2Bulk(command, cwd) {
  const spec = aria2InputSpec(command)
  if (!spec) return null
  // The manifest's outputs are relative to where aria2c ends up running, which is
  // the agent directory after any `cd` in the same command — not the session
  // directory the call started in.
  const base = commandWorkingDirectory(command, cwd) || cwd || null
  const listPath = isAbsolute(spec.input) ? spec.input : base ? resolve(base, spec.input) : null
  if (!listPath) return null
  let body
  try {
    const stat = statSync(listPath)
    if (!stat.isFile() || stat.size > ARIA_INPUT_MAX_BYTES) return null
    body = readFileSync(listPath, 'utf8')
  } catch {
    return null
  }
  const entries = parseAria2Input(body)
  if (entries.length === 0 || entries.length > ARIA_INPUT_MAX_ENTRIES) return null
  // `-d` on the command line is the batch default; an entry's own `dir=` wins.
  const cliDir = spec.dir
    ? isAbsolute(spec.dir)
      ? spec.dir
      : base
        ? resolve(base, spec.dir)
        : null
    : base
  const targets = []
  const urls = []
  const seen = new Set()
  for (const entry of entries) {
    if (!/^https?:\/\//i.test(entry.url)) continue
    const dir = entry.dir
      ? isAbsolute(entry.dir)
        ? entry.dir
        : cliDir
          ? resolve(cliDir, entry.dir)
          : null
      : cliDir
    const name = entry.out || aria2EntryName(entry.url)
    if (!dir || !name) continue
    const target = isAbsolute(name) ? name : resolve(dir, name)
    if (seen.has(target)) continue
    seen.add(target)
    targets.push(target)
    urls.push(entry.url)
  }
  return targets.length ? { targets, urls, listPath } : null
}
