    /* ================================================================== */
    /* Shared utilities                                                     */
    /*                                                                      */
    /* The host serves the client half as ONE bundle, so unlike the Host    */
    /* half this file cannot import from a sibling module. Everything that  */
    /* is used in more than one place therefore lives in this block, and    */
    /* every call site below goes through it instead of re-deriving the     */
    /* same values in its own little copy.                                  */
    /* ================================================================== */

    /** Join class names, dropping falsy entries: `cx('a', cond && 'b')`. */
    function cx() {
      return Array.prototype.filter.call(arguments, Boolean).join(' ')
    }

    /** Clamp a number into [lo, hi]. */
    function clamp(n, lo, hi) {
      return Math.max(lo, Math.min(hi, n))
    }

    /** Read and parse a localStorage key; any failure yields the fallback. */
    function readJSON(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        return raw ? JSON.parse(raw) : fallback
      } catch {
        /* private mode, corrupted value, or storage disabled */
        return fallback
      }
    }

    /** Persist a value. A full or blocked storage must not break the UI. */
    function writeJSON(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* keep the in-memory value for this page */
      }
    }

    const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

    /**
     * Human-readable size: `1234567` → `1.18 MB`.
     * Precision drops as the number grows (0 / 1 / 2 decimals) so the readout
     * never jitters between `9.99 MB` and `10.0 MB` on every poll.
     */
    function fmtBytes(n) {
      const value = Number(n)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      let size = value
      let unit = 0
      while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
        size /= 1024
        unit += 1
      }
      const text =
        unit === 0 ? String(Math.round(size)) : size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)
      return text + ' ' + BYTE_UNITS[unit]
    }

    /** Bytes per second, or '' when there is no rate worth showing. */
    function fmtSpeed(n) {
      const value = Number(n)
      return Number.isFinite(value) && value > 0 ? fmtBytes(value) + '/s' : ''
    }

    /** Milliseconds → whole seconds, floored at 0. */
    function secs(ms) {
      const value = Number(ms)
      return Number.isFinite(value) && value > 0 ? Math.floor(value / 1000) : 0
    }

    /** The single line of context printed under every bar. */
    function logOf(task) {
      return String(task.log || '')
    }

