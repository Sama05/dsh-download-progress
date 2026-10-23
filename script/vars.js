import { MAX_DEPTH } from './tuning.js'

/**
 * Every `$name = value` assignment, plus `param()`/`[type]$name = value` defaults.
 *
 * @param {string} body
 * @returns {Map<string, string>} name (without `$`) to raw right-hand side
 */
export function collectAssignments(body) {
  const out = new Map()
  // `$x = value` starting a line.
  const lineRe = /^\s*\$([A-Za-z_][\w]*)\s*=\s*(.+?)\s*$/gm
  let m
  while ((m = lineRe.exec(body))) {
    let value = m[2]
    // A trailing comment is only a comment outside a string literal.
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, '')
    out.set(m[1], value.trim())
  }
  // `param([string]$Dest = 'D:\ISO')` and `[string]$Dest = 'D:\ISO'`: neither
  // starts a line with `$`, so the anchor above misses both. A destination pinned
  // in a default has no other source, and that default IS what runs when the
  // caller omits the switch — dropping it made a realistic script resolve to
  // nothing while a trivial one worked.
  const paramRe =
    /(?:^|[\s(,;\]])\$([A-Za-z_][\w]*)\s*=\s*("[^"]*"|'[^']*'|\$[A-Za-z_][\w]*|[^\s,;)]+)/g
  let pm
  while ((pm = paramRe.exec(body))) {
    // The line form recorded it first and is the more specific reading.
    if (out.has(pm[1])) continue
    out.set(pm[1], pm[2].trim())
  }
  return out
}

/**
 * Replace `$env:NAME` with its value from `env`.
 *
 * Matching is case-insensitive because Windows environment variables are.
 * Unknown names are left in place so the caller sees an unresolved value rather
 * than a path with a hole in it.
 */
function expandEnv(text, env) {
  if (!env) return text
  return text.replace(/\$env:([A-Za-z_][\w]*)/gi, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? String(env[key]) : whole
  })
}

/**
 * True when a right-hand side needs the script to run to be known.
 *
 * `$( )` is a subexpression, a backtick is an escape, and `@'`/`@"` open a
 * here-string. Each of those can produce a different path on every run, so the
 * value is not statically resolvable at all.
 */
function needsRuntime(text) {
  return text.includes('$(') || text.includes('`') || /^@["']/.test(text)
}

/**
 * Resolve one assignment's right-hand side to a literal string, or `null`.
 *
 * The three shapes chain rather than being exclusive: `Join-Path $Dest
 * "$Edition.iso"` is a cmdlet call whose arguments are a variable and an
 * interpolated string, so unwrapping, interpolating and evaluating all have to
 * happen in one pass. Giving quotes an early `return` produced the literal text
 * `Join-Path D:\ISO "Win11_22H2.iso"` instead of the path.
 *
 * @param {string} raw right-hand side as written
 * @param {Map<string, string>} vars
 * @param {Record<string, string>} [env]
 * @param {number} [depth]
 * @returns {string | null}
 */
export function resolveValue(raw, vars, env, depth = 0) {
  if (depth > MAX_DEPTH) return null
  let text = String(raw ?? '').trim()
  if (!text) return null
  if (needsRuntime(text)) return null

  // 1) One layer of quotes. Only double quotes interpolate.
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text)
  if (quoted) {
    let inner = expandEnv(quoted[2], env)
    if (quoted[1] === '"') {
      let ok = true
      inner = inner.replace(/\$([A-Za-z_][\w]*)/g, (whole, name) => {
        const v = vars.has(name) ? resolveValue(vars.get(name), vars, env, depth + 1) : null
        if (v === null) ok = false
        return v === null ? whole : v
      })
      if (!ok) return null
    }
    text = inner.trim()
    // Interpolation can itself have left a `$name` we could not expand (the
    // whole-match fallback above), so re-check before trusting the result.
    if (!text || needsRuntime(text)) return null
  }

  // 2) A cmdlet that produces a path. `Join-Path` is pervasive in real download
  //    scripts, and without it a large share of them resolve to nothing, which
  //    reads as "the feature does not work".
  const join = /^Join-Path\s+(.+)$/i.exec(text)
  if (join) {
    const parts = join[1].match(/"[^"]*"|'[^']*'|\$[A-Za-z_][\w]*|[^\s]+/g) || []
    const resolved = parts.map((p) => resolveValue(p, vars, env, depth + 1))
    if (resolved.some((p) => p === null)) return null
    return resolved.join('\\').replace(/\\{2,}/g, '\\')
  }

  // 3) A bare variable.
  const bare = /^\$([A-Za-z_][\w]*)$/.exec(text)
  if (bare) return vars.has(bare[1]) ? resolveValue(vars.get(bare[1]), vars, env, depth + 1) : null

  // 4) A literal token with no spaces and nothing left to expand. A leading `$`
  //    here means an unexpanded variable that matched no rule above.
  if (text.startsWith('$')) return null
  if (!/[\s(){}@]/.test(text)) return text
  return null
}
