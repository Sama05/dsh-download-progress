/**
 * dsh-download-progress — Client half.
 *
 * Two contributions, both purely client-side (the Host half only serves data):
 *
 *  1. `shell.overlay` (scope root) — one frame-wide floating indicator, so it
 *     survives session switches and never participates in layout: nothing
 *     above it can be pushed around when it appears or disappears.
 *  2. `settings.section` (scope root) — one page in DSH Settings, following the
 *     same slot the shipped/installed plugins use. Preferences persist in
 *     localStorage (origin-scoped), so the Host half needs no change at all and
 *     nothing here depends on the shape of the settings transport service.
 *
 * All visual styling lives in the single `CSS` constant below. Changing the
 * look means editing that block only — the component tree stays untouched.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-download-progress',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/download-progress/state'
    const POLL_MS = 1000
    /**
     * Highest `schemaVersion` this bundle has seen on the wire.
     *
     * Only a diagnostic: the store never refuses a frame because of it (an
     * additive field is a legal change, see CONTRACT.md). It exists so a
     * mismatch can be reported instead of silently looking like "the UI is
     * just not updating".
     */
    let SCHEMA_VERSION_SEEN = 1
    /**
     * Consecutive failed polls before the last frame is dropped.
     *
     * A host that is restarting (or a route that briefly 502s) should not blank the
     * overlay — the download is still running. A host that has been gone for five
     * seconds is not coming back in this second, and a frozen bar that never moves
     * again is worse than no bar.
     */
    const POLL_FAILURES_BEFORE_CLEAR = 5

