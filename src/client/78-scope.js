    /* ---------------- current-session scope ---------------- */

    /**
     * The session the main view is showing right now, or '' when no session
     * occupies it.
     *
     * The centre column renders the session whose `retainedBy.mainView` is set;
     * that is the same projection the shipped title/sidebar code reads, so this
     * follows the user's session switch without any host change. A right-hand
     * panel (file browser, terminal…) owns the main key instead, and in that
     * position no session is "current" — returning '' there makes the overlay
     * fall back to the full list rather than go blank.
     *
     * @param {object} state `useSessions` snapshot
     * @returns {string}
     */
    function mainSessionIdOf(state) {
      const byId = (state && state.byId) || {}
      for (const id of Object.keys(byId)) {
        const row = byId[id]
        if (!row) continue
        const held = row.retainedBy && (row.retainedBy.mainView ?? 0) > 0
        if (held) return String(row.id || id)
      }
      return ''
    }

    /** Selector form, so the overlay only re-renders when the session changes. */
    function selectMainSessionId(state) {
      return mainSessionIdOf(state)
    }

    /** Stand-in when the slot hands no session hook over (offline smoke test). */
    function noSessions() {
      return ''
    }

    /**
     * Drop every row that belongs to another session.
     *
     * Only applied when the user asked for the current session AND that session
     * is actually known: a blank scope keeps the full list, because hiding every
     * download with no way to see why would look like the plugin broke. Rows
     * without a session id (an older host) are kept for the same reason — they
     * cannot be attributed, so they are never the reason something disappears.
     *
     * @param {object[]} list
     * @param {string} sessionId
     * @returns {object[]}
     */
    function scopeToSession(list, sessionId) {
      if (!sessionId) return list
      return list.filter((task) => {
        const own = sessionKeyOf(task)
        return !own || own === sessionId
      })
    }

    /** One session block: a name header plus that session's cards. */
    function Group(props) {
      const run = props.run
      return h(
        'div',
        { className: 'ddp-group' },
        h(
          'div',
          { className: 'ddp-group-head' },
          // The title gets the whole width; hovering a truncated one reveals it.
          h('span', { className: 'ddp-group-name', title: run.name }, run.name),
          run.tasks.length > 1
            ? h('span', { className: 'ddp-group-count' }, run.tasks.length + ' 项')
            : null,
        ),
        h(
          'div',
          { className: 'ddp-group-cards' },
          run.tasks.map((task, index) =>
            h(Card, {
              key: task.id || String(index),
              task,
              showSpeed: props.showSpeed,
              ease: props.ease,
              phase: props.phase,
              // The stagger is per session block, so two sessions that start at
              // once do not double each other's delay into a 400ms wait.
              index,
            }),
          ),
        ),
      )
    }

