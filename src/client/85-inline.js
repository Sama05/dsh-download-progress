    /* ---------------- inline bar (composer tool row) ---------------- */

    /**
     * The one thing an inline chip says about a task, plus which of the three
     * bodies should say it.
     *
     * Deliberately NOT `describe()`: that one builds a name and a size readout
     * for a card with room to print them. The tool row is ~22px tall and shared
     * with other plugins' chips, so this returns only the facts a body can
     * actually paint. Keeping it separate also means tuning the compact wording
     * never drifts the overlay's.
     *
     * The shape is decided by what the data can support, never by the task's
     * name: a fraction needs a known total, so only a resolved download gets
     * the bar. Everything else is motion (ring) or, when even the kind is
     * missing, three dots.
     *
     * @param {object} task
     */
    function briefOf(task, capabilities) {
      const bytes = Number(task.bytes) || 0
      const total = Number(task.total)
      const hasTotal = Number.isFinite(total) && total > 0
      const speed = Number(task.speed) || 0
      const rate = fmtSpeed(speed)
      const kind = String(task.kind || '')
      const source = String(task.progressSource || 'none')
      const stream = streamState(capabilities)

      // Only a download with a known total has a fraction worth drawing. Every
      // other shape would have to invent one. A transfer that has counted no
      // byte yet (aria2c preallocation, or a connection still being made) is
      // not 0% — it is not measuring yet — so it falls through to the ring.
      // Not gated on `done`: a background download is `done` from its first
      // tick while the job runs on (see the same note in `describe`).
      const staged = kind === 'download' && task.staged === true
      const preparing = kind === 'download' && !staged && bytes === 0 && speed === 0
      // A `fetch` gets the same bar once the stream sensor measured it, which is
      // what the depth-progress switch buys. Without a total there is nothing to
      // draw, so it stays a ring.
      const measurable =
        (kind === 'download' && !task.unresolved && !staged && !preparing) ||
        (kind === 'fetch' && bytes > 0)
      const percent =
        hasTotal && measurable ? clamp((bytes / total) * 100, 0, 100) : null

      if (percent !== null) {
        return {
          shape: 'bar',
          percent,
          rate,
          // The length already carries the fraction; the number is the second
          // copy of it, so it waits for a pointer.
          tip: percent.toFixed(1) + '%',
          aria: { 'aria-valuenow': Math.round(percent) },
        }
      }

      if (!kind) {
        // Not even the kind of work is known: nothing honest to spell out.
        return {
          shape: 'dots',
          percent: null,
          rate: '',
          tip: '处理中',
          aria: { 'aria-valuetext': '处理中' },
        }
      }

      // Work is in flight but unmeasurable. The ring carries the motion; the
      // words move into the hover bubble, which is the only place with room.
      const label =
        kind === 'search'
          ? '搜索中'
          : kind === 'fetch'
            ? '抓取中'
            : kind === 'install'
              ? '安装中'
              : kind === 'download'
                ? preparing
                  ? '准备中'
                  : '下载中'
                : '处理中'
      const elapsed = secs(task.elapsedMs)
      const bits = [label + (elapsed > 0 ? ' · ' + elapsed + 's' : '')]
      // A download whose total never resolved still knows how much landed.
      if (kind === 'download' && bytes > 0) bits.push(fmtBytes(bytes))
      if (rate) bits.push(rate)
      // One phrase about the unmeasurable case, in a bubble that has room for it.
      // Only a stream-shaped task can be helped by the switch; saying "turn it on"
      // over an install would be a promise nothing can keep.
      if (source === 'stream') {
        if (stream === 'off') bits.push('可开启深度进度')
        else if (stream === 'unavailable') bits.push('环境不支持深度进度')
        else if (stream === 'degraded') bits.push('深度进度已降级')
      }
      return {
        shape: 'ring',
        percent: null,
        rate,
        tip: bits.join(' · '),
        aria: { 'aria-valuetext': label },
      }
    }

    /**
     * Flatten one background row into what a row paints.
     *
     * Background work has no fraction, so there is deliberately no `percent`
     * here: a progress bar that cannot move is worse than a word. The state
     * word is the payload, and `waiting` is the distinction that makes it
     * honest — see `backgroundBrief` for why.
     *
     * @param {object} row
     */
    function describeBackground(row) {
      const waiting = row.waiting === true
      const status = String(row.status || '')
      const elapsed = secs(row.elapsedMs)
      const state = waiting
        ? '等待中'
        : status === 'stopping'
          ? '停止中'
          : status === 'done'
            ? '已完成'
            : status === 'failed'
              ? '失败'
              : '运行中'
      // A job's label is the command line that started it, which can be a
      // screenful. One line, capped: the row exists to say *that* something
      // runs, and the full text stays in the tooltip.
      const raw = String(row.label || '后台任务')
      const firstLine = raw.split('\n')[0].trim() || '后台任务'
      return {
        label: firstLine.length > 48 ? firstLine.slice(0, 47) + '…' : firstLine,
        detail: String(row.detail || ''),
        state,
        waiting,
        meta: elapsed > 0 ? elapsed + 's' : '',
        type: String(row.type || ''),
      }
    }

    /**
     * One background row inside the overlay list.
     *
     * A flat line rather than a card: a card promises a track and a fill, and
     * this has neither. The tint marks `waiting` so the eye lands on the one
     * row that explains why the agent is quiet.
     */
    function BackgroundRow(props) {
      const view = describeBackground(props.row || {})
      return h(
        'div',
        {
          className: cx('ddp-bgrow', view.waiting && 'ddp-bgrow--waiting'),
          title: view.detail || view.label,
        },
        h('span', { className: 'ddp-bgdot', 'aria-hidden': 'true' }),
        h('span', { className: 'ddp-bgname' }, view.label),
        view.detail ? h('span', { className: 'ddp-bgdetail' }, view.detail) : null,
        h('span', { className: 'ddp-bgstate' }, view.state),
        view.meta ? h('span', { className: 'ddp-bgmeta' }, view.meta) : null,
      )
    }

    /**
     * Compact presenter for background work, or null when there is none.
     *
     * Same output shape as `briefOf`, so the chip can switch between "a
     * transfer" and "the agent is waiting on something" without the view
     * knowing which it is holding.
     *
     * The distinction this preserves is the point of the feature: `waiting`
     * means the agent's current tool call is blocked on this row, `running`
     * only means it is still going. A chip that called both "waiting" would be
     * lying half the time.
     *
     * @param {object[]} rows background rows from the wire
     * @returns {object|null}
     */
    function backgroundBrief(rows) {
      const list = Array.isArray(rows)
        ? rows.filter((row) => row && typeof row === 'object')
        : []
      if (list.length === 0) return null

      const waiting = list.filter((row) => row.waiting === true)
      const live = list.filter((row) => row.status === 'running' || row.status === 'stopping')
      const head = waiting[0] || live[0] || list[0]
      const label = waiting.length > 0 ? '等待后台任务' : '后台运行中'
      const count = (live.length || list.length) - 1

      const bits = [label]
      const name = String(head.label || '')
      if (name) bits.push(name.length > 16 ? name.slice(0, 15) + '…' : name)
      if (count > 0) bits.push('+' + count)
      const elapsed = secs(head.elapsedMs)
      if (elapsed > 0) bits.push(elapsed + 's')

      return {
        // The ring, not the bar: background work has no fraction to draw.
        shape: 'ring',
        percent: null,
        rate: '',
        tip: bits.join(' · '),
        aria: { 'aria-valuetext': label },
      }
    }

    /**
     * Compact presenter for the composer's tool row.
     *
     * Three inputs decide what it paints: the slot's own `sessionId` (so it can
     * only ever show this conversation), the shared task list, and the display
     * setting. It renders nothing at all when this session is idle — an empty
     * chip would occupy a neighbour's space for no information, which is the
     * whole reason the chip opts out of growing.
     */
    // Fallback geometry for the SVG d attribute. The stylesheet's d wins at
    // render time and is what actually interpolates between the two shapes;
    // these strings keep the paths visible if a renderer ignores the CSS
    // property, in which case the change degrades to a hard cut rather than to
    // nothing at all. Both are M + four C segments on purpose.
    const RING_D =
      'M 6.5 1.25 C 9.4 1.25 11.75 3.6 11.75 6.5 C 11.75 9.4 9.4 11.75 6.5 11.75 C 3.6 11.75 1.25 9.4 1.25 6.5 C 1.25 3.6 3.6 1.25 6.5 1.25'
    const BAR_D =
      'M 2.5 6.5 C 22 6.5 42 6.5 61.5 6.5 C 61.5 6.5 61.5 6.5 61.5 6.5 C 61.5 6.5 61.5 6.5 61.5 6.5 C 61.5 6.5 61.5 6.5 61.5 6.5'

    // The resting state. An idle session still owns the chip, so the three
    // dots are what the ring collapses into and expands out of; without them
    // the chip would blink out of the row and the transition would have no
    // destination.
    const IDLE_BRIEF = {
      shape: 'dots',
      percent: null,
      rate: '',
      tip: '空闲',
      aria: { 'aria-valuetext': '空闲' },
    }

    function InlineBar(props) {
      const settings = useSettings()
      const wantsInline = settings.display === 'inline' || settings.display === 'both'
      const frame = useTasks(Boolean(settings.enabled && wantsInline))
      const tasks = frame.tasks
      const background = frame.background

      const sessionId = String((props && props.sessionId) || '')
      const mine = (Array.isArray(tasks) ? tasks : []).filter(
        (task) => task && typeof task === 'object' && sessionKeyOf(task) === sessionId,
      )
      // Background work for THIS session only: another session's job is not
      // this chip's business, and the row it sits in belongs to one composer.
      const mineBackground = (Array.isArray(background) ? background : []).filter(
        (row) => row && typeof row === 'object' && String(row.sessionId || '') === sessionId,
      )

      // Hooks are all above this line: the early returns below must never change
      // the hook count between renders.
      //
      // An idle session keeps the chip. It used to bail out here, which made the
      // dots unreachable — the resting state is the whole point of the ring
      // having somewhere to collapse to.
      if (!settings.enabled || !wantsInline || !sessionId) return null

      // Several calls in one session: the chip tracks the oldest, and a count
      // says how many others are queued behind it. Drawing a stacked bar for a
      // 22px row would say less than the number does.
      //
      // A transfer outranks background work: it is the thing with a number to
      // show. Background only takes the chip when nothing is transferring,
      // which is exactly when "the agent is waiting" is the useful message.
      const head = mine[0]
      const bg = head ? null : backgroundBrief(mineBackground)
      // `streamState` lives in 70-views.js; every fragment shares one closure, so
      // the chip and the card cannot disagree about what the switch is doing.
      const brief = head ? briefOf(head, frame.capabilities) : bg || IDLE_BRIEF
      const extra = mine.length - 1

      const style = themeTokens(settings.theme) || undefined

      // One clipped viewBox holds both shapes. The wrapper's width is what
      // changes (13px ring -> 64px bar); the paths inside morph by `d`, so the
      // ring unrolls into the bar instead of two elements cross-fading.
      const progress = brief.percent === null ? 0 : brief.percent / 100
      return h(
        'div',
        {
          className: 'ddp-mx ddp-mx--' + brief.shape,
          style,
          // Screen readers get the number without needing a pointer.
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          ...brief.aria,
          // No title attribute: the browser's native tooltip duplicates our own
          // hover tip, paints in system chrome, and fades in and out on its own
          // schedule. The aria values above already carry the number.
        },
        h(
          'span',
          { className: 'ddp-mx-shape' },
          h(
            'svg',
            { viewBox: '0 0 64 13', width: 64, height: 13, 'aria-hidden': 'true', focusable: 'false' },
            h('path', { className: 'ddp-mx-arc', d: brief.shape === 'bar' ? BAR_D : RING_D }),
            h('path', {
              className: 'ddp-mx-prog',
              d: brief.shape === 'bar' ? BAR_D : RING_D,
              // The ring shows a short spinning arc (9 of its ~33 units); the
              // bar shows the real fraction of the 59-unit run, rounded caps
              // adding the last 5px on each end.
              style: {
                strokeDasharray:
                  brief.shape === 'bar'
                    ? (59 * progress).toFixed(2) + ' 200'
                    : '9 24',
              },
            }),
          ),
        ),
        h(
          'span',
          { className: 'ddp-mx-dots' },
          h('span', null),
          h('span', null),
          h('span', null),
        ),
        h(
          'span',
          { className: 'ddp-mx-rate' },
          settings.showSpeed && brief.rate ? brief.rate : '',
        ),
        extra > 0 ? h('span', { className: 'ddp-mx-extra' }, '+' + extra) : null,
        h('span', { className: 'ddp-mx-tip' }, brief.tip),
      )
    }

