    function Overlay(props) {
      const settings = useSettings()
      const frame = useTasks(settings.enabled)
      const liveTasks = frame.tasks
      const liveBackground = frame.background

      // The session the centre column is showing. Called unconditionally and
      // from a stable prop, so the hook order never changes between renders —
      // a conditional hook here would kill the overlay permanently.
      const useSessions = (props && props.useSessions) || noSessions
      const currentSessionId = useSessions(selectMainSessionId)

      // "Current session only" is a display filter, applied before anything
      // else looks at the rows, so the grouping / height / row-cap logic below
      // sees exactly what will be painted and needs no second code path.
      const scoped = settings.currentOnly
        ? scopeToSession(liveTasks, currentSessionId)
        : liveTasks

      // Peeking = the pointer is on the handle / the expanded list. Only allowed
      // when nothing real is in flight, so samples can never sit next to real rows.
      const [peeking, setPeeking] = React.useState(() => peekState.on)
      // Only a well-formed row counts as a real download. An array of nulls must
      // not suppress the sample cards and then paint an empty overlay.
      const realTasks = (Array.isArray(scoped) ? scoped : []).filter(
        (task) => task && typeof task === 'object',
      )
      const hasReal = realTasks.length > 0
      // Background rows keep the overlay alive on their own: "the agent is
      // waiting on a job" is exactly the case where the user wants to see the
      // overlay and there is no transfer to show.
      const realBackground = (Array.isArray(liveBackground) ? liveBackground : []).filter(
        (row) => row && typeof row === 'object',
      )
      const scopedBackground = settings.currentOnly
        ? realBackground.filter((row) => String(row.sessionId || '') === currentSessionId)
        : realBackground
      const hasBackground = scopedBackground.length > 0
      // A download in ANOTHER session still counts for one thing only: it keeps
      // the sample workbench off. Otherwise scoping to a quiet session would
      // summon five fake cards while a real transfer runs next door.
      const hasAnyReal = liveTasks.some((task) => task && typeof task === 'object')
      // Sample cards exist only as a UI workbench. With debug mode off the overlay
      // shows nothing but real downloads, so a placeholder can never be mistaken
      // for an actual transfer.
      const canPeek = settings.debugMode

      const samples = useSampleTasks(peeking && !hasAnyReal && canPeek, peekState.at)
      const tasks = hasReal ? realTasks : samples

      // Turning debug mode off must not leave a pending collapse or a stale peek
      // session behind, or the samples would pop back the next time it is enabled.
      // Turning it on reveals the samples immediately: with only the slim grip on
      // screen there is nothing to see, so the toggle would look like a no-op.
      React.useEffect(() => {
        if (!canPeek) {
          cancelLeave()
          setPeek(false)
          setPeeking(false)
          return
        }
        setPeek(true)
        setPeeking(true)
      }, [canPeek])

      const [drag, setDrag] = React.useState(null)
      // Needed on resize: the clamp limit depends on how wide the card actually
      // is, which only the DOM knows.
      const wrapRef = React.useRef(null)
      const [resizing, setResizing] = React.useState(false)

      React.useEffect(() => {
        if (typeof window === 'undefined' || !window.addEventListener) return undefined
        const move = (event) => {
          const session = dragSession
          if (!session) return
          const dx = (Number(event.clientX) || 0) - session.startX
          const dy = (Number(event.clientY) || 0) - session.startY
          if (!session.moved && Math.abs(dx) + Math.abs(dy) < 5) return
          session.moved = true
          // Peeking grows the wrapper (5 sample cards), so re-measure instead of
          // trusting the size captured on pointerdown — otherwise the clamp would
          // use a 12px-tall box while the overlay is 300px tall.
          let width = session.width
          let height = session.height
          if (session.el && typeof session.el.getBoundingClientRect === 'function') {
            const rect = session.el.getBoundingClientRect()
            width = rect.width
            height = rect.height
          }
          session.last = clampInto(session.originX + dx, session.originY + dy, width, height)
          setDrag(session.last)
          if (event.cancelable) event.preventDefault()
        }
        const finish = () => {
          const session = dragSession
          dragSession = null
          if (session && session.moved && session.last) {
            // Persist the centre as a percentage: the drop position is a pixel
            // offset, but only the ratio survives a window resize.
            writeSettings({ x: session.last.pct, y: session.last.y })
          }
          setDrag(null)
        }

        // A live window resize does two things that matter here: every card
        // re-blurs a large backdrop per frame (expensive), and a card dragged
        // toward an edge can end up half outside a narrower window. One
        // rAF-throttled handler deals with both.
        let raf = 0
        let idleTimer = 0
        const applyResize = () => {
          raf = 0
          setResizing(true)
          const stored = readSettings().x
          if (stored === null) return
          const el = wrapRef.current
          if (!el || typeof el.getBoundingClientRect !== 'function') return
          const width = el.getBoundingClientRect().width
          const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
          // The card still fits while its centre stays half a card plus the
          // 8px edge padding away from both sides.
          const margin = ((width / 2 + 8) / vw) * 100
          const low = Math.min(margin, 50)
          const high = Math.max(100 - margin, 50)
          const next = Math.round(Math.min(high, Math.max(low, stored)) * 100) / 100
          if (Math.abs(next - stored) >= 0.5) writeSettings({ x: next })
        }
        const onResize = () => {
          if (!raf) {
            raf = window.requestAnimationFrame
              ? window.requestAnimationFrame(applyResize)
              : (applyResize(), 0)
          }
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            idleTimer = 0
            setResizing(false)
          }, RESIZE_IDLE_MS)
        }

        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
        window.addEventListener('resize', onResize)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
          window.removeEventListener('resize', onResize)
          if (raf && window.cancelAnimationFrame) window.cancelAnimationFrame(raf)
          if (idleTimer) clearTimeout(idleTimer)
          // A pending collapse must not fire after the overlay is gone.
          cancelLeave()
          dragSession = null
        }
      }, [])

      // Every hook must run on every render, including the renders that produce
      // nothing. Returning early before usePresence / useState below would change
      // the hook count between renders and React would throw "Rendered fewer hooks
      // than expected" — which kills the overlay permanently, so toggling debug
      // mode off and back on could never bring it back.
      const show = hasReal || hasBackground || (peeking && samples.length > 0)
      const { visible, leaving } = usePresence(show, enterAnimMs(settings.enterAnim))

      // While the exit animation runs the list is already empty, so the last
      // populated frame is what actually animates out.
      const held = React.useState(() => ({ list: [] }))[0]
      // The route body is JSON from another process. A null or non-object entry
      // must be dropped here: `Card` and the React key both read `task.id`, and a
      // throw inside a slot unmounts the entire overlay — one bad row would take
      // the whole thing down instead of costing one card.
      const safeTasks = (Array.isArray(tasks) ? tasks : []).filter(
        (task) => task && typeof task === 'object',
      )
      if (safeTasks.length) held.list = safeTasks
      const shown = safeTasks.length ? safeTasks : held.list

      // Horizontal placement. The wrapper is ALWAYS centred with
      // `translateX(-50%)`, and `left` always names the card's centre — pixels
      // while dragging, a percentage once dropped. Keeping the transform
      // constant matters: `left` is on a 180ms transition, the transform is not.
      // Flipping the transform at the drop instant (none ⇄ translateX(-50%))
      // while `left` was still easing to its new value shifted the card half a
      // width instantly and then slid it back — the "jumps left, then snaps
      // back" flicker seen right after releasing the mouse.
      const position = { top: (drag ? drag.y : settings.y) + 'px' }
      position.transform = 'translateX(-50%)'
      if (drag) {
        position.left = drag.x + drag.half + 'px'
      } else if (settings.x === null) {
        position.left = '50%'
      } else {
        position.left = settings.x + '%'
      }
      // Theme = custom properties on the wrapper. 'auto' contributes nothing, so
      // each rule falls through to the host token it already had.
      const themeStyle = themeTokens(settings.theme)
      if (themeStyle) Object.assign(position, themeStyle)
      // Peeking shows every sample shape at once, so the row cap must not clip it.
      const rows = hasReal
        ? settings.maxVisible
        : Math.max(settings.maxVisible, shown.length || settings.maxVisible)
      position['--ddp-rows'] = String(rows)

      const ordered = settings.order === 'newest-first' ? shown.slice().reverse() : shown

      // Session blocks. One session keeps the flat list it has always been (the
      // group header would be pure noise when there is nothing to tell apart);
      // two or more sessions each get their own block, labelled with the name the
      // sidebar shows. Sample cards carry no session id, so they always stay flat.
      const runs = runsOf(ordered)
      const grouped = runs.length > 1
      // Every block adds a header line on top of its cards, so the height budget
      // has to grow with the number of blocks or the last card gets clipped.
      // One block costs 6+8 padding + 2 border + 8 gap + a 15.4px 11px header,
      // so 40px keeps a little slack. The gap COUNT is unchanged by grouping
      // ((N-1) between N cards either way), so nothing else needs adjusting.
      position['--ddp-heads'] = grouped ? runs.length * 40 + 'px' : '0px'
      // The background block is a header line plus one ~27px row each, and it
      // sits outside the row budget, so it needs its own height allowance.
      position['--ddp-bg'] = hasBackground
        ? scopedBackground.length * 27 + 22 + 'px'
        : '0px'

      // Bail out only here: all hooks above have already run, so the hook count
      // stays identical whether or not anything is painted.
      if (!settings.enabled) return null
      // The user picked the simple bar as the ONE presenter. The overlay keeps
      // polling (it must, in case they switch back), but paints nothing.
      if (settings.display === 'inline') return null
      // Real downloads always show. Without one, the overlay exists only in debug
      // mode — otherwise it renders nothing at all (not even the grip).
      if (!hasReal && !hasBackground && !canPeek) return null

      const enter = (event) => {
        // Nothing to peek at unless debug mode is on; a real download keeps the
        // overlay up on its own.
        if (!canPeek) return
        // Cancel any pending collapse before deciding: coming back onto the grip
        // or the cards always wins over a collapse that was just scheduled.
        cancelLeave()
        const node = event && event.currentTarget
        const from = event && event.relatedTarget
        if (node && typeof node.contains === 'function' && from && node.contains(from)) return
        setPeek(true)
        setPeeking(true)
      }
      const leave = (event) => {
        // A drag owns the overlay until pointerup: collapsing the peek mid-drag
        // would make the cards disappear under the cursor while the pointer is
        // still held down.
        if (dragSession) return
        const node = event && event.currentTarget
        const to = event && event.relatedTarget
        if (node && typeof node.contains === 'function' && to && node.contains(to)) return
        scheduleLeave(() => {
          setPeek(false)
          setPeeking(false)
        })
      }

      const handle = hasReal || hasBackground
        ? null
        : h(
            'div',
            {
              className: cx('ddp-handle', canPeek && 'ddp-handle--debug'),
              onPointerDown: beginDrag,
              title: canPeek ? '拖动可调整位置 · 悬停展开示例' : '拖动可调整位置',
            },
            canPeek ? '下载进度条 · 示例预览' : null,
          )

      return h(
        'div',
        {
          ref: wrapRef,
          className: cx(
            'ddp-wrap',
            peeking && !hasReal && 'ddp-wrap--peek',
            drag && 'ddp-wrap--drag',
            resizing && 'ddp-wrap--resizing',
          ),
          'aria-live': 'polite',
          style: position,
          onPointerOver: enter,
          onPointerOut: leave,
        },
        handle,
        visible
          ? h(
              'div',
              {
                className: 'ddp-list',
                onPointerDown: beginDrag,
              },
              // Background rows sit above the transfers: when one of them is
              // waiting it explains the silence, and it is the shorter list.
              hasBackground
                ? h(
                    'div',
                    { className: 'ddp-bgblock' },
                    h('div', { className: 'ddp-bghead' }, '后台任务'),
                    scopedBackground.map((row, index) =>
                      h(BackgroundRow, { key: row.id || 'bg-' + index, row }),
                    ),
                  )
                : null,
              grouped
                ? runs.map((run, index) =>
                    h(Group, {
                      key: run.key || 'session-' + index,
                      run,
                      showSpeed: settings.showSpeed,
                      ease: settings.enterAnim,
                      phase: leaving ? 'out' : 'in',
                    }),
                  )
                : ordered.map((task, index) =>
                    h(Card, {
                      key: task.id || String(index),
                      task,
                      showSpeed: settings.showSpeed,
                      ease: settings.enterAnim,
                      phase: leaving ? 'out' : 'in',
                      index,
                    }),
                  ),
            )
          : null,
      )
    }

