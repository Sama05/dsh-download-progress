    /* ---------------- data ---------------- */

    /** Absolute URL of the host snapshot route, robust to a missing location. */
    function stateUrl() {
      try {
        return new URL(ROUTE, window.location.origin).toString()
      } catch {
        return ROUTE
      }
    }

    /**
     * The one task poller, shared by every surface that draws a task.
     *
     * The floating overlay and the composer chip sit in two different slots, so
     * they are two different React trees and no context can join them. Each used
     * to call useTasks() and therefore ran its own fetch loop: two requests a
     * second for one route, two copies of the same list that could disagree for
     * a tick, and two failure counters that could retire the same card at
     * different moments. That is exactly the kind of split that makes a bug show
     * up on one surface and not the other, so the loop and its state live here
     * once and every surface reads the same frame.
     *
     * Reference counted: the first reader starts the loop, the last one stops it,
     * so a session with every surface switched off still makes no requests.
     */
    const taskStore = {
      /**
       * Last frame, kept so a late subscriber starts from live data.
       *
       * A frame is the whole wire body the UI cares about — the transfer list
       * and the background list together. Keeping them in one object is what
       * lets both surfaces read one consistent snapshot instead of one surface
       * showing transfers from t=0 and background from t=1.
       */
      frame: { tasks: [], background: [] },
      /** Readers to notify on every frame. */
      readers: new Set(),
      /** The one interval, or null while nobody is watching. */
      timer: null,
      /** Consecutive misses; any success resets it. */
      failures: 0,

      publish(next) {
        this.frame = next
        for (const reader of this.readers) {
          try {
            reader(next)
          } catch {
            /* one broken reader must not starve the others */
          }
        }
      },

      miss() {
        // Keep the last frame through a short blip, drop it once the host is
        // clearly gone — the policy the per-component loop used, now applied
        // once for every surface instead of once per surface.
        if (++this.failures >= POLL_FAILURES_BEFORE_CLEAR) {
          this.publish({ tasks: [], background: [] })
        }
      },

      /**
       * Turn one wire body into the frame this store publishes.
       *
       * The body is `{ schemaVersion, tasks, background }` (see CONTRACT.md). A
       * body with a NEWER version than this bundle understands is still
       * rendered: an additive field the UI has never heard of is exactly the
       * case the contract is designed to allow, and refusing the frame would
       * blank the overlay for a purely cosmetic mismatch. A body with no
       * version at all is an older host, and a bare array is the oldest body
       * this plugin ever shipped — both are read field by field.
       *
       * @param {unknown} data
       * @returns {{tasks: object[], background: object[]}}
       */
      adopt(data) {
        if (Array.isArray(data)) return { tasks: data, background: [] }
        if (!data || typeof data !== 'object') return { tasks: [], background: [] }
        const version = Number(data.schemaVersion)
        // Forward compatibility is deliberate: never gate the frame on it.
        if (Number.isFinite(version) && version > SCHEMA_VERSION_SEEN) {
          SCHEMA_VERSION_SEEN = version
        }
        return {
          tasks: Array.isArray(data.tasks) ? data.tasks : [],
          background: Array.isArray(data.background) ? data.background : [],
        }
      },

      tick() {
        if (typeof document !== 'undefined' && document.hidden) return
        fetch(stateUrl(), { cache: 'no-store' })
          .then((res) => (res && res.ok ? res.json() : null))
          .then((data) => {
            if (!data) {
              // Missing/!ok response: hold the frame, drop it after the ceiling.
              this.miss()
              return
            }
            this.failures = 0
            this.publish(this.adopt(data))
          })
          .catch(() => {
            /* the host route is optional: stay silent when it is absent */
            this.miss()
          })
      },

      start() {
        if (this.timer !== null) return
        this.tick()
        this.timer = setInterval(() => this.tick(), POLL_MS)
      },

      stop() {
        if (this.timer === null) return
        clearInterval(this.timer)
        this.timer = null
      },

      /**
       * Join the shared frame.
       *
       * A late subscriber is handed the frame already on screen, so the chip
       * does not blink through an empty list when the overlay mounted first.
       * Nothing is handed over while the store is still empty: an idle mount is
       * then not a state change, which keeps "no news" distinguishable from
       * "the list just emptied".
       *
       * @param {(frame: {tasks: object[], background: object[]}) => void} reader
       * @returns {() => void} unsubscribe
       */
      subscribe(reader) {
        this.readers.add(reader)
        const idle = this.frame.tasks.length === 0 && this.frame.background.length === 0
        if (!idle) {
          try {
            reader(this.frame)
          } catch {
            /* one broken reader must not starve the others */
          }
        }
        this.start()
        return () => {
          this.readers.delete(reader)
          if (this.readers.size === 0) this.stop()
        }
      },
    }

    const EMPTY_FRAME = { tasks: [], background: [] }

    /**
     * Read the shared frame.
     *
     * `enabled` false means "this surface is off": it unsubscribes and reports
     * nothing. That is what lets a disabled overlay leave the chip's loop
     * running without drawing anything itself.
     *
     * @param {boolean} enabled
     * @returns {{tasks: object[], background: object[]}}
     */
    function useTasks(enabled) {
      const [frame, setFrame] = React.useState(EMPTY_FRAME)
      React.useEffect(() => {
        if (!enabled) {
          setFrame(EMPTY_FRAME)
          return undefined
        }
        return taskStore.subscribe(setFrame)
      }, [enabled])
      return frame
    }

