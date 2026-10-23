    /* ---------------- per-session grouping ---------------- */

    /**
     * Which session a row belongs to, as a stable grouping key.
     *
     * Tasks from one session share this value and are drawn inside one block.
     * Sample cards have no session at all, so they all land under '' and the
     * overlay renders them as the flat list it has always been — a debug peek
     * must not invent session blocks for data that belongs to no session.
     *
     * @param {object} task
     */
    function sessionKeyOf(task) {
      return String((task && task.sessionId) || '')
    }

    /**
     * The name shown on a session block.
     *
     * The host already resolves the real title and falls back to a short id, so
     * this only has to cope with a row that carries neither (an older host, or a
     * sample). '' means "no session", which keeps the flat one-session layout.
     *
     * @param {object} task
     */
    function sessionNameOf(task) {
      const title = String((task && task.sessionTitle) || '')
      if (title) return title
      const id = String((task && task.sessionId) || '')
      return id ? '会话 ' + id.slice(-8) : ''
    }

    /**
     * Split an already-ordered row list into per-session runs.
     *
     * Deliberately a RUN of consecutive rows, not a dict keyed by session: the
     * user's chosen order (newest-first / oldest-first) then still decides what
     * is on top, and a session that starts a second download later returns to
     * the top with a fresh block instead of silently reordering rows inside a
     * block that is already on screen.
     *
     * @param {object[]} list ordered rows
     * @returns {{key: string, name: string, tasks: object[]}[]}
     */
    function runsOf(list) {
      const runs = []
      for (const task of list) {
        const key = sessionKeyOf(task)
        const last = runs[runs.length - 1]
        if (last && last.key === key) last.tasks.push(task)
        else runs.push({ key, name: sessionNameOf(task), tasks: [task] })
      }
      return runs
    }

