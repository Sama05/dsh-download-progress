/**
 * Turning one dispatch into one card.
 *
 * This is where a tool call becomes byte counts: which paths it will write, what
 * to call it, where its bytes come from, and whether an existing card should
 * adopt it as a retry. Everything here runs once, inside the tool-call waterfall,
 * so it must never throw and never block.
 */

import { PKG_RE } from '../detect.js'
import { expandPlan } from '../plan.js'
import { clip, firstLine, text } from '../utils.js'
import { probeBulkTotal, probeTotal } from './probes.js'
import { findByTarget, retarget, tasks } from './registry.js'

/**
 * Register a task for a dispatch that earned a card.
 *
 * @param {{callId?: string, name?: string}} exec
 * @param {{kind: string, label?: string, detail?: string, command?: string}} plan from `classify()`
 * @param {string} cwd resolved agent working directory
 * @returns {object} the task, so the caller can mark it done
 */
export function beginTask(exec, plan, cwd) {
  const startedAt = Date.now()
  const id = text(exec?.callId) || `${startedAt}-${Math.random()}`
  const task = {
    // `||` rather than `??`: an empty callId would collide every such dispatch
    // onto the same key, so a blank id gets a unique one too.
    id,
    kind: plan.kind,
    name: text(exec?.name),
    // Which session started this call. The overlay uses it to group several
    // concurrent downloads into one small block per session, labelled with the
    // session name. Empty when the call carries no agent (never in practice).
    sessionId: text(exec?.agent?.id),
    sessionTitle: '',
    titleAt: 0,
    label: plan.label ?? '',
    startedAt,
    bytes: 0,
    total: null,
    speed: 0,
    phase: '',
    // One line of context under the bar. Every shape fills this with whatever it
    // knows: the URL, the full query, the command, or the newest pnpm line.
    log: clip(plan.detail ?? '', 160),
    done: false,
    targets: [],
    // Set when the command runs aria2c, whose target is preallocated to the full
    // size before any bytes land. `stat()` is then meaningless until the `.aria2`
    // sidecar appears, so this task waits for a bitmap reading instead.
    aria2: false,
    // Set when the command is `git clone`, whose target is a *directory*. A
    // directory's `stat().size` is always 0 on Windows, so the sampler sums the
    // files underneath it instead of reading the target itself.
    clone: false,
    // Set when the downloader stages its bytes somewhere else and only renames
    // them onto the destination at the very end (`Start-BitsTransfer`). The
    // destination then never grows, so there is no percentage to show and the
    // sampler must not pretend the transfer is stalled.
    staged: false,
    // Set when the command reads its targets from an aria2c input file: the
    // count is then a sum over many files, which has to be monotone because a
    // retried file legitimately truncates.
    bulk: false,
    // Per-target final size, learned from the bulk probe. Lets `sample()` prefer
    // the live file size over a minute-stale aria2c bitmap, without mistaking a
    // preallocated file for a finished one.
    bulkSizes: null,
    history: [],
    idleTicks: 0,
    // Set once a target's mtime proves the *running* downloader touched it. Until
    // then a file that was already on disk when the dispatch started is that
    // previous transfer's bytes, not this one's — see `sample()`.
    freshTarget: false,
    // When the measured count last stepped up. The rate is that step divided by
    // the interval since this stamp, because a bitmap-backed count arrives in
    // whole-minute jumps rather than continuously.
    lastGrowthAt: 0,
    expiresAt: 0,
    // Which layer is measuring this task, so the client can explain a card that
    // has no percentage instead of leaving it blank. `file` is the disk sampler,
    // `stream` is the undici wrapper, `none` means neither can see this kind of
    // work at all (installs, package managers).
    progressSource: 'none',
    // The URL a stream sensor can match its byte events against. Only `fetch`
    // and `search` set it: a disk-sampled download is matched by path instead,
    // and an install has no URL at all.
    url: '',
  }

  // `web_fetch` and the search tools hand the host a URL and get bytes back over
  // HTTP; nothing lands on disk, so the only measurement available is the stream
  // sensor. A download resolves real target paths and is sampled from the file
  // system, which works whether or not the switch is on.
  if (plan.kind === 'fetch' || plan.kind === 'search') {
    // `detail` carries the full argument (`classify()` clips only `label`), so a
    // long URL still matches the stream event exactly.
    task.url = text(plan.detail)
    task.progressSource = 'stream'
  } else if (plan.kind === 'download') {
    task.progressSource = 'file'
  }

  if (plan.kind === 'download') {
    // Which files, which URL, which downloader, and what to call the card: all
    // of it is resolved one layer up, in `plan/expand.js`. This file never
    // parses a command, so a new downloader syntax is a change in that layer
    // alone. `null` means the dispatch turned out not to write anything (a
    // `-File` script that only prints), so no card is created.
    const expanded = expandPlan(plan, cwd)
    if (!expanded) return null
    task.aria2 = expanded.aria2
    task.clone = expanded.clone
    task.staged = expanded.staged
    task.bulk = Boolean(expanded.bulk)
    task.targets = expanded.targets
    // A retry is the *same transfer*, not a second one. `curl -C - -o x.iso …`
    // run again after a dropped connection writes the very file the previous
    // attempt was writing, so a fresh card would stack a second bar on top of
    // the first and both would show the same bytes. Re-keying onto the target
    // makes the existing card adopt the new dispatch instead — its `startedAt`
    // and idle counter restart, the name and size carry over.
    if (task.targets.length === 1) {
      const previous = findByTarget(task.targets[0], task.sessionId)
      if (previous && previous.id !== task.id) return retarget(previous, { id, startedAt })
    }
    task.label = task.label || expanded.label
    task.log = expanded.log
    if (expanded.bulk) probeBulkTotal(expanded.bulk.urls, expanded.bulk.targets, task)
    else if (expanded.url) probeTotal(expanded.url, task)
  } else if (plan.kind === 'pkg') {
    const match = text(plan.command).match(PKG_RE)
    task.label = match ? match[1].replace(/\s+/g, ' ') : '安装'
    task.log = clip(firstLine(plan.command), 160)
  } else if (plan.kind === 'install') {
    task.log = clip('pnpm add ' + (plan.label || '…'), 160)
  }

  tasks.set(task.id, task)
  return task
}
