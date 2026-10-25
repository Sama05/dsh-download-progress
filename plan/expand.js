/**
 * A dispatch -> the concrete files it will write.
 *
 * The join of the two recognition sources: the command line (`detect.js`) and a
 * script the command line names (`script.js`). See `../plan.js` for why this is
 * its own layer.
 */

import { basename } from 'node:path'
import { extractTargets, remoteFileName, runsAria2, runsGitClone, transferIsStaged } from '../detect.js'
import { scriptPlan } from '../script.js'
import { clip, extractUrl, firstLine, text } from '../utils.js'
import { readAria2Bulk } from './aria2.js'

/**
 * Expand one `download` plan into the concrete shape a card needs.
 *
 * @param {{kind?: string, command?: string, script?: boolean}} plan from `classify()`
 * @param {string} cwd resolved agent working directory
 * @returns {null | {
 *   aria2: boolean,
 *   clone: boolean,
 *   staged: boolean,
 *   bulk: null | { targets: string[], urls: string[], listPath: string },
 *   targets: string[],
 *   url: string,
 *   remote: string,
 *   label: string,
 *   log: string,
 * }} `null` means "not a transfer after all": the dispatch is dropped rather
 *   than given a card that can never move.
 */
export function expandPlan(plan, cwd) {
  const command = text(plan?.command)
  // aria2c fills the target to its final length before the first byte arrives.
  // Until its `.aria2` sidecar exists there is no honest byte count, so the card
  // waits instead of reporting the preallocation (100 %) or the disk write that
  // created it (a wildly inflated rate).
  const aria2 = runsAria2(command)
  // `git clone` writes a directory tree, not a file: the sampler has to sum the
  // tree rather than stat the target.
  const clone = runsGitClone(command)
  // BITS stages every byte in a `BITxxxx.tmp` beside the destination and renames
  // it at the very end, so the destination never grows and no rate can be read
  // off it. The card shows elapsed time instead of a bar that would sit at 0 %.
  const staged = transferIsStaged(command)
  // `aria2c -i list.txt` names every real target inside the list file, so the
  // command line alone yields no target and the card used to sit on "载入中" for
  // the whole batch. Read the manifest and treat the batch as one transfer.
  const bulk = aria2 ? readAria2Bulk(command, cwd) : null
  let targets = bulk ? bulk.targets : extractTargets(command, cwd)
  // `powershell -File get-iso.ps1` carries no destination and no URL: both are
  // inside the script. Read it now, while the dispatch is still being set up. A
  // script that names no output path is not a download at all (it might only
  // print something), so the plan collapses instead of leaving a permanent 0 %
  // card on screen.
  let fromScript = null
  if (plan?.script) {
    fromScript = scriptPlan(command, cwd)
    if (!fromScript) return null
    targets = fromScript.targets
  }
  // The command line has no URL in the `-File` case; the script does. Only a
  // single distinct URL is trusted as the source — several means the script
  // downloads more than one thing and no single denominator applies.
  const url = extractUrl(command) || (fromScript?.urls.length === 1 ? fromScript.urls[0] : '')
  const remote = remoteFileName(command)
  return {
    aria2,
    clone,
    staged,
    bulk,
    targets,
    url,
    remote,
    // Which name to show:
    //   one target  -> that file's basename. It is the real file being written,
    //                  so `-o win11.iso` reads as `win11.iso` even when the URL
    //                  ends in something unhelpful like `/download?id=7`.
    //   many targets -> the URL's own basename. A segmented transfer writes
    //                  `part1.bin … part8.bin` for one logical file, and naming
    //                  the card after `targets[0]` showed a fragment of the name
    //                  instead of what the user actually asked for.
    //   a batch      -> the count, because there is no single file to name.
    label: !bulk && targets.length === 1
      ? basename(targets[0])
      : !bulk && targets.length > 1 && remote
        ? remote
        : bulk
          ? `批量下载 ${bulk.targets.length} 个文件`
          : remote || '下载',
    // Where the bytes come from is the most useful line; then the resolved path;
    // then the raw command when neither could be parsed. A batch has no single
    // URL, so it names the manifest instead.
    log: bulk
      ? clip(`${basename(bulk.listPath)} · ${bulk.targets.length} 个文件`, 160)
      : clip(url || targets[0] || firstLine(command), 160),
  }
}
