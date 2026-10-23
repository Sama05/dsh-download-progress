/**
 * background/tuning.js — part of the background-row bookeeper.
 *
 * Split out of background.js; the module doc that explains the whole design
 * (why "running" and "waiting" differ, and why every producer is optional)
 * lives in background.js.
 */
/** Tools whose call does not return until background work finishes. */
export const WAIT_TOOLS = new Set([
  'job_output', // only when wait:true, checked separately
  'job_wait',
  'subagent',
  'subagent_fork',
  'workflow',
])

/** Tools that block only with a specific argument. */
export const CONDITIONAL_WAIT = {
  job_output: (args) => args && args.wait === true,
}

/**
 * Shell tools. Their foreground calls ALSO register a `jobs` entry while they
 * run — the registry is what the shell tool uses to stream output, and a
 * foreground call removes its entry when it returns. Those entries are not
 * background work: the transcript already shows the call, and painting a second
 * row for it would double-report every command the agent runs.
 */
export const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'exec'])

/** Slack when matching a job's start against the call that is running it. */
export const FOREGROUND_GRACE_MS = 1000

/** A background row disappears this long after it settles. */
export const LINGER_MS = 4000

/**
 * How long a running row may go without a lifecycle event before its status is
 * re-read from the registry.
 *
 * The event stream is not a complete picture: a subscriber that joins late (a
 * plugin reload) can be replayed a `registered` snapshot from before the job
 * settled and then never see the matching `settled`. A running row is
 * deliberately exempt from the linger sweep, so without this re-check such a
 * ghost would sit on the overlay forever.
 */
export const RECONCILE_AFTER_MS = 30_000

/** Upper bound on rows, so a runaway producer cannot grow the payload. */
export const MAX_ROWS = 20
