/**
 * HEAD probes for the denominator: one URL, or a whole batch.
 *
 * A card without a total shows an indeterminate ring, so this is what turns the
 * bar into a percentage. Both probes are fire-and-forget — `beginTask` starts
 * them and returns — which is exactly why each needs its own semaphore: nothing
 * upstream throttles a loop that issues two hundred curls.
 */

/**
 * One HEAD probe for a batch entry, retried twice.
 *
 * A slow origin answers some of a dozen simultaneous HEADs and drops the rest;
 * a single miss would otherwise throw away the whole denominator. Returns 0 when
 * the size really is unknowable, which makes `probeBulkTotal` abandon the sum
 * rather than publish a short one.
 *
 * @param {string} url
 * @returns {Promise<number>}
 */
async function probeBulkSize(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await acquireBulkProbeSlot()
    try {
      // A one-byte ranged GET rather than HEAD. Origins that front a batch of
      // images frequently drop HEAD — safebooru timed out on ten of twelve —
      // while the same request with a Range header answered every one and
      // reported the full size in `Content-Range`. The byte itself is discarded.
      const res = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(BULK_PROBE_TIMEOUT_MS),
      })
      let length = 0
      if (res.status === 206) {
        const range = res.headers.get('content-range') || ''
        const total = Number(range.split('/')[1])
        if (Number.isFinite(total) && total > 0) length = total
      } else if (res.ok) {
        // Range ignored: the headers still carry the full size, so read it and
        // drop the body instead of downloading the file to learn nothing.
        const reported = Number(res.headers.get('content-length'))
        if (Number.isFinite(reported) && reported > 0) length = reported
      }
      await res.body?.cancel().catch(() => {})
      if (length > 0) return length
    } catch {
      /* fall through to the retry */
    } finally {
      releaseBulkProbeSlot()
    }
    // A rejected probe (403 on a Cloudflare-fronted origin, say) will not start
    // working on a retry, but a timeout might, so back off briefly either way.
    await new Promise((done) => setTimeout(done, 400))
  }
  return 0
}

/**
 * Sum the `content-length` of every URL in a batch, so a bulk card gets a real
 * denominator instead of an indeterminate ring.
 *
 * Bulk probes run on their own, much narrower semaphore. Origins that serve a
 * manifest happily will drop most of a dozen simultaneous HEADs — safebooru
 * answered 6 of 12 that way, and the same instinct is what starved the Microsoft
 * CDN earlier. At three at a time every entry answers, so the sum is exact.
 *
 * A missing size makes the bar stop short of 100 %, and a partial total is a
 * worse lie than no total at all, so the whole probe is abandoned unless every
 * entry answers. Very large batches skip the probe entirely: the card would sit
 * indeterminate for minutes, and nobody reads a 1 % step on a 500-file job.
 *
 * @param {string[]} urls
 * @param {object} task
 */
export async function probeBulkTotal(urls, targets, task) {
  if (urls.length === 0 || urls.length > BULK_PROBE_MAX_ENTRIES) return
  // A batch of a dozen HEADs is asked while the download itself is already
  // saturating the link, so a miss is usually congestion rather than a real
  // "no size". Retry in rounds, re-probing only the entries that stayed silent,
  // until every one answers or the rounds run out. One stubborn entry would
  // otherwise cost the card its denominator for the whole transfer.
  let pending = urls.slice()
  const sizes = new Map()
  for (let round = 0; round <= BULK_PROBE_ROUNDS && pending.length > 0; round += 1) {
    if (round > 0) await new Promise((done) => setTimeout(done, BULK_PROBE_ROUND_DELAY_MS))
    // The probe is kicked off from `beginTask` before the task is published into
    // `tasks`, so a membership check here would always fail. A retired task just
    // gets a total written to a dead object, which nobody reads.
    if (task.expiresAt) return
    const batch = pending
    pending = []
    const answers = await Promise.all(
      batch.map(async (url) => /** @type {[string, number]} */ ([url, await probeBulkSize(url)])),
    )
    for (const [url, size] of answers) {
      if (size > 0) sizes.set(url, size)
      else pending.push(url)
    }
  }
  if (pending.length > 0) return
  let total = 0
  for (const url of urls) total += sizes.get(url) ?? 0
  if (total > 0 && task.total === null) {
    task.total = total
    // Keep the per-file sizes too: `sample()` uses them to tell a live file size
    // from an aria2c preallocation.
    const perTarget = new Map()
    urls.forEach((url, index) => {
      const target = targets[index]
      const size = sizes.get(url)
      if (target && size > 0) perTarget.set(target, size)
    })
    task.bulkSizes = perTarget
  }
}

/**
 * How many HEAD probes may be in flight at once.
 *
 * A probe is fire-and-forget: `beginTask` kicks it off and returns, so nothing
 * upstream throttles them. A loop that issues two hundred curls therefore used
 * to open two hundred probes at the same instant, each holding a socket and a
 * six-second abort timer. Eight is enough to keep a burst resolving quickly
 * while keeping the host's connection count flat.
 */
const PROBE_CONCURRENCY = 8

/** Probes currently running, and the waiters queued behind the limit. */
let probesInFlight = 0
const probeWaiters = []

/** Resolve once a probe slot is free, then take it. */
async function acquireProbeSlot() {
  if (probesInFlight < PROBE_CONCURRENCY) {
    probesInFlight++
    return
  }
  // The releasing probe hands its slot straight to this waiter, so the counter
  // is not decremented and re-incremented in between.
  await new Promise((resolve) => probeWaiters.push(resolve))
}

/** Release a slot, passing it to the oldest waiter if there is one. */
function releaseProbeSlot() {
  const next = probeWaiters.shift()
  if (next) next()
  else probesInFlight--
}

/**
 * A much narrower limiter for bulk HEAD probes.
 *
 * An origin that will happily serve a manifest drops most of a dozen
 * simultaneous HEADs — safebooru answered six of twelve, and the same instinct
 * is what starved the Microsoft CDN in an earlier run. At three at a time every
 * entry answers, which matters because a batch total is only adopted when it is
 * exact.
 */
const BULK_PROBE_CONCURRENCY = 3
const BULK_PROBE_TIMEOUT_MS = 12_000
/** Past this many entries the probe is skipped: the card would spin for minutes. */
const BULK_PROBE_MAX_ENTRIES = 100
/** Extra passes over the entries that stayed silent, and the pause between them. */
const BULK_PROBE_ROUNDS = 2
const BULK_PROBE_ROUND_DELAY_MS = 12_000

let bulkProbesInFlight = 0
const bulkProbeWaiters = []

/** Resolve once a bulk probe slot is free, then take it. */
async function acquireBulkProbeSlot() {
  if (bulkProbesInFlight < BULK_PROBE_CONCURRENCY) {
    bulkProbesInFlight++
    return
  }
  await new Promise((resolve) => bulkProbeWaiters.push(resolve))
}

/** Release a bulk slot, passing it to the oldest waiter if there is one. */
function releaseBulkProbeSlot() {
  const next = bulkProbeWaiters.shift()
  if (next) next()
  else bulkProbesInFlight--
}

/**
 * Best-effort total size via HEAD.
 *
 * Not every server sends `content-length`, and a HEAD can be rejected outright;
 * in both cases the card degrades to an indeterminate bar instead of showing a
 * made-up denominator.
 *
 * @param {string} url
 * @param {object} task
 */
export async function probeTotal(url, task) {
  await acquireProbeSlot()
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) })
    // A rejected HEAD still carries a body length — Cloudflare answers 403 with a
    // one-byte error page, and `content-length: 1` would then be adopted as the
    // file's size, leaving the card stuck on "0 B / 1 B". Only a successful
    // response describes the resource we are actually downloading.
    if (!res.ok) return
    const length = Number(res.headers.get('content-length'))
    if (Number.isFinite(length) && length > 0) task.total = length
  } catch {
    /* best effort: keep total = null */
  } finally {
    releaseProbeSlot()
  }
}
