/**
 * dsh-download-progress — Host half.
 *
 * Observes tool dispatch through the official `tools/execute` waterfall and
 * publishes a compact JSON snapshot that the Client half polls once per second.
 * It never mutates the calls it wraps: every branch that does not own the
 * decision returns `next()`.
 */
import { statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'

const ROUTE_PATH = '/download-progress/state'
const TICK_MS = 1000
const IDLE_TICKS_TO_CLOSE = 3
const LINGER_MS = 1200

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

const SEARCH_TOOLS = new Set([
  'web_search',
  'advanced_search',
  'multi_search',
  'research',
  'platform_search',
  'video_search',
  'domain_search',
  'free_search_test',
])

const FETCH_TOOLS = new Set(['web_fetch'])
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal_send'])

const CURL_WGET_RE = /(?:^|[\s;&|])(curl(?:\.exe)?|wget(?:\.exe)?)(?=[\s;&|]|$)/i
const IWR_RE = /(?:^|[\s;&|])(Invoke-WebRequest|iwr)(?=[\s;&|]|$)/i
const PS_OUTFILE_RE = /(?:^|\s)-OutFile(?=\s)/i
const GIT_CLONE_RE = /\bgit\s+clone\b/i
const PKG_RE =
  /\b(pnpm\s+(?:add|i|install)|npm\s+(?:i|install|add)|yarn\s+add|pip\s+install|uv\s+(?:add|pip)|docker\s+pull|ollama\s+pull)\b/i

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/** @type {Map<string, any>} */
const tasks = new Map()

function clip(text, max = 50) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

function extractUrl(command) {
  const m = String(command).match(/https?:\/\/[^\s"'<>]+/)
  return m ? m[0] : ''
}

/** First non-empty line of a command or log blob. */
function firstLine(raw) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length ? lines[0] : ''
}

/** Last non-empty line: cards only ever show the newest line, never a tail dump. */
function lastLine(raw) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length ? lines[lines.length - 1] : ''
}

function extractTargets(command, cwd) {
  const out = []
  const base = cwd || process.cwd()
  const push = (raw) => {
    if (!raw) return
    const clean = String(raw).replace(/^["']|["']$/g, '')
    if (!clean || clean.startsWith('-')) return
    out.push(isAbsolute(clean) ? clean : resolve(base, clean))
  }

  // curl -o / --output / --output-document (lowercase -o only: -O means remote name)
  const explicit = /(?:^|\s)(?:-o|--output|--output-document)\s+("([^"]+)"|'([^']+)'|(\S+))/g
  let m
  while ((m = explicit.exec(command))) push(m[2] || m[3] || m[4])

  // PowerShell -OutFile
  const ps = /(?:^|\s)-OutFile\s+("([^"]+)"|'([^']+)'|(\S+))/gi
  while ((m = ps.exec(command))) push(m[2] || m[3] || m[4])

  // curl -O / --remote-name: target is cwd + basename(url)
  if (/(?:^|\s)(?:-O|--remote-name)(?=\s|$)/.test(command)) {
    const url = extractUrl(command)
    if (url) {
      try {
        push(basename(new URL(url).pathname))
      } catch {
        /* ignore malformed URL */
      }
    }
  }

  // git clone <url> <dir>
  if (GIT_CLONE_RE.test(command)) {
    const idx = command.search(GIT_CLONE_RE)
    const tokens = command.slice(idx).split(/\s+/).filter(Boolean)
    const positional = tokens.slice(2).filter((t) => !t.startsWith('-'))
    if (positional.length >= 2) push(positional[1])
  }

  return [...new Set(out)]
}

function classify(exec) {
  const name = String(exec?.name ?? '')
  const args = exec?.arguments ?? {}

  if (SEARCH_TOOLS.has(name)) {
    const query = args.query ?? args.question ?? args.q ?? ''
    // label is clipped for the headline; detail keeps the full query for the log
    // line under the bar.
    return { kind: 'search', label: clip(query, 50), detail: String(query ?? '') }
  }

  if (FETCH_TOOLS.has(name)) {
    const url = args.url ?? ''
    return { kind: 'fetch', label: clip(url, 120), detail: String(url ?? '') }
  }

  if (name === 'plugin_manager') {
    const action = String(args.action ?? '')
    if (action.includes('install')) {
      return { kind: 'install', label: clip(args.target ?? args.name ?? '', 80) }
    }
    return null
  }

  if (SHELL_TOOLS.has(name)) {
    const command = String(args.command ?? args.text ?? '')
    if (!command) return null
    // `Invoke-WebRequest` without `-OutFile` buffers in memory: nothing to sample.
    const isIwrToFile = IWR_RE.test(command) && PS_OUTFILE_RE.test(command)
    if (CURL_WGET_RE.test(command) || GIT_CLONE_RE.test(command) || isIwrToFile) {
      return { kind: 'download', command }
    }
    if (PKG_RE.test(command)) {
      return { kind: 'pkg', command }
    }
  }

  return null
}

/* ------------------------------------------------------------------ */
/* Task lifecycle                                                      */
/* ------------------------------------------------------------------ */

function beginTask(exec, plan, cwd) {
  const id = String(exec?.callId ?? `${Date.now()}-${Math.random()}`)
  const task = {
    id,
    kind: plan.kind,
    name: String(exec?.name ?? ''),
    label: plan.label ?? '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    bytes: 0,
    total: null,
    speed: 0,
    phase: '',
    // One line of context under the bar. Every shape fills this when it knows
    // something useful (URL, full query, command, or the newest pnpm line).
    log: clip(plan.detail ?? '', 160),
    done: false,
    targets: [],
    history: [],
    lastBytes: 0,
    lastSampleAt: Date.now(),
    idleTicks: 0,
    expiresAt: 0,
  }

  if (plan.kind === 'download') {
    task.targets = extractTargets(plan.command, cwd)
    if (!task.label) {
      task.label = task.targets.length
        ? basename(task.targets[0])
        : basename(extractUrl(plan.command) || '') || '下载'
    }
    const url = extractUrl(plan.command)
    // The most useful line for a transfer is where it comes from; fall back to
    // the resolved path, then to the command itself when neither could be read.
    task.log = clip(url || task.targets[0] || firstLine(plan.command), 160)
    if (url) probeTotal(url, task)
  } else if (plan.kind === 'pkg') {
    const m = String(plan.command).match(PKG_RE)
    task.label = m ? m[1].replace(/\s+/g, ' ') : '安装'
    task.phase = 'running'
    task.log = clip(firstLine(plan.command), 160)
  } else if (plan.kind === 'install') {
    task.log = clip('pnpm add ' + (plan.label || '…'), 160)
  }

  tasks.set(id, task)
  return task
}

async function probeTotal(url, task) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) })
    const len = Number(res.headers.get('content-length'))
    if (Number.isFinite(len) && len > 0) {
      task.total = len
      task.updatedAt = Date.now()
    }
  } catch {
    /* HEAD is best effort: an unknown total degrades to an indeterminate bar. */
  }
}

function sample(task, now) {
  if (task.kind !== 'download' || task.targets.length === 0) return

  let size = 0
  for (const p of task.targets) {
    try {
      size += statSync(p).size
    } catch {
      /* the file may not exist yet */
    }
  }

  const prev = task.bytes
  task.bytes = size
  task.idleTicks = size > prev ? 0 : task.idleTicks + 1

  // A short sliding window gives a stable rate without the EMA's slow tail.
  task.history.push({ t: now, s: size })
  while (task.history.length > 6) task.history.shift()
  const first = task.history[0]
  const span = now - first.t
  if (span >= 900) {
    const grew = size - first.s
    task.speed = grew > 0 ? (grew * 1000) / span : 0
  }
}

function sweep(now) {
  for (const [id, task] of tasks) {
    sample(task, now)

    const fileQuiet = task.kind !== 'download' || task.targets.length === 0 || task.idleTicks >= IDLE_TICKS_TO_CLOSE
    const ready = task.done && fileQuiet

    if (ready) {
      if (!task.expiresAt) task.expiresAt = now + LINGER_MS
      if (now >= task.expiresAt) tasks.delete(id)
    }
  }
}

function snapshot() {
  const now = Date.now()
  return [...tasks.values()].map((t) => ({
    id: t.id,
    kind: t.kind,
    name: t.name,
    label: t.label,
    bytes: t.bytes,
    total: t.total,
    speed: Math.round(t.speed),
    phase: t.phase,
    log: t.log,
    startedAt: t.startedAt,
    elapsedMs: Math.max(0, now - t.startedAt),
    done: t.done,
    unresolved: t.kind === 'download' && t.targets.length === 0,
  }))
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export const inject = ['webServer']

export function apply(ctx) {
  // 1s sampler
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        sweep(Date.now())
      } catch {
        /* never let a sample throw into the host */
      }
    }, TICK_MS)
    return () => clearInterval(timer)
  })

  // Around-dispatch observation: this listener owns no decision.
  ctx.on('tools/execute', async (exec, next) => {
    let plan = null
    try {
      plan = classify(exec)
    } catch {
      plan = null
    }
    if (!plan) return next()

    let cwd = ''
    try {
      const wd = ctx.get('workingDirectory')
      if (wd && exec?.agent) cwd = await wd.ensure(exec.agent)
    } catch {
      cwd = ''
    }

    const task = beginTask(exec, plan, cwd)
    try {
      return await next()
    } finally {
      task.done = true
      task.updatedAt = Date.now()
    }
  })

  // Plugin install: streamed pnpm output and phase changes.
  ctx.on('plugin-manager/install-log', (chunk) => {
    // pnpm writes whole blocks at a time; keep only the newest line so the card
    // never shows a multi-line tail.
    const line = clip(lastLine(chunk?.text), 160)
    if (!line) return
    for (const task of tasks.values()) {
      if (task.kind === 'install') {
        task.log = line
        task.updatedAt = Date.now()
      }
    }
  })

  ctx.on('plugin-manager/install-state', (progress) => {
    const phase = String(progress?.phase ?? '')
    if (!phase) return
    for (const task of tasks.values()) {
      if (task.kind === 'install') {
        task.phase = phase
        task.updatedAt = Date.now()
      }
    }
  })

  // Snapshot route polled by the Client half.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => {
        let body
        try {
          body = JSON.stringify({ tasks: snapshot() })
        } catch {
          body = '{"tasks":[]}'
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    }),
  )
}
