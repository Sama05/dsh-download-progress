/**
 * Turning one dispatch into one card.
 *
 * This is where a tool call becomes byte counts: which paths it will write, what
 * to call it, where its bytes come from, and whether an existing card should
 * adopt it as a retry. Everything here runs once, inside the tool-call waterfall,
 * so it must never throw and never block.
 */

import { basename } from 'node:path'
import { PKG_RE, extractTargets, remoteFileName, runsAria2, runsGitClone } from '../detect.js'
import { scriptPlan } from '../script.js'
import { clip, extractUrl, firstLine, text } from '../utils.js'
import { readAria2Bulk } from './aria2.js'
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
  }

  if (plan.kind === 'download') {
    // aria2c fills the target to its final length before the first byte arrives.
    // Until its `.aria2` sidecar exists there is no honest byte count, so the
    // card waits rather than reporting the preallocation (100 %) or the disk
    // write that created it (a wildly inflated rate).
    task.aria2 = runsAria2(plan.command)
    // `git clone` writes a directory tree, not a file: the sampler has to sum the
    // tree (see `directoryBytes`) rather than stat the target.
    task.clone = runsGitClone(plan.command)
    // `aria2c -i list.txt` names every real target inside the list file, so the
    // command line alone yields no target and the card used to sit on "载入中"
    // for the whole batch. Read the manifest and treat the batch as one transfer:
    // bytes are the sum across files, which is what a bulk download looks like.
    const bulk = task.aria2 ? readAria2Bulk(plan.command, cwd) : null
    task.bulk = Boolean(bulk)
    task.targets = bulk ? bulk.targets : extractTargets(plan.command, cwd)
    // `powershell -File get-iso.ps1` carries no destination and no URL: both are
    // inside the script. Read it now, while the dispatch is still being set up,
    // and take the paths from there. A script that names no output path is not a
    // download at all (it might only print something), so the task is dropped
    // instead of leaving a permanent 0 % card on screen.
    let fromScript = null
    if (plan.script) {
      fromScript = scriptPlan(plan.command, cwd)
      if (!fromScript) return null
      task.targets = fromScript.targets
    }
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
    // The command line has no URL in the `-File` case; the script does. Only a
    // single distinct URL is trusted as the source — several means the script
    // downloads more than one thing and no single denominator applies.
    const url = extractUrl(plan.command) || (fromScript?.urls.length === 1 ? fromScript.urls[0] : '')
    // Which name to show:
    //   one target  -> that file's basename. It is the real file being written,
    //                  so `-o win11.iso` reads as `win11.iso` even when the URL
    //                  ends in something unhelpful like `/download?id=7`.
    //   many targets -> the URL's own basename. A segmented transfer writes
    //                  `part1.bin … part8.bin` for one logical file, and naming
    //                  the card after `targets[0]` showed a fragment of the name
    //                  instead of what the user actually asked for.
    const remote = remoteFileName(plan.command)
    task.label =
      task.label ||
      (bulk
        ? `批量下载 ${bulk.targets.length} 个文件`
        : task.targets.length > 1 && remote
          ? remote
          : task.targets.length
            ? basename(task.targets[0])
            : remote || '下载')
    // Where the bytes come from is the most useful line; then the resolved path;
    // then the raw command when neither could be parsed. A batch has no single
    // URL, so it names the manifest instead.
    task.log = bulk
      ? clip(`${basename(bulk.listPath)} · ${bulk.targets.length} 个文件`, 160)
      : clip(url || task.targets[0] || firstLine(plan.command), 160)
    if (bulk) probeBulkTotal(bulk.urls, bulk.targets, task)
    else if (url) probeTotal(url, task)
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
