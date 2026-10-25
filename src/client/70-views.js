    /* ---------------- overlay view ---------------- */

    /**
     * Per-kind headline + meta builders.
     *
     * Before this table each shape was another `if` block repeating the same
     * `log: String(task.log || '')` and the same `elapsed + 's'`; adding a shape
     * meant touching four places. Now a shape is one entry, and anything a
     * builder does not return falls back to the shared values below.
     */
    const VIEWS = {
      /** Real bytes: size, optional total, optional rate. */
      download(task, ctx) {
        if (task.unresolved) return { name: '载入中...', meta: ctx.elapsed + 's' }
        // The downloader writes its bytes to a staging file and renames them onto
        // the target only at the end, so the target stays at 0 until the transfer
        // is over. A bar there would read 0 % for the whole download; the clock is
        // the only honest thing to show.
        if (task.staged) return { name: task.label || '下载中...', meta: ctx.elapsed + 's' }
        // No byte has been counted yet. For aria2c that is the preallocation
        // window, which can last a while on a large file: its bitmap does not
        // exist yet, so the host deliberately reports nothing rather than the
        // preallocated size. Saying "0 B / 7 GiB · 0 B/s" there is a claim the
        // plugin cannot back up, and it reads as a stalled download.
        if (ctx.preparing) return { name: task.label || '下载中...', meta: '准备中...' }
        const size = ctx.hasTotal
          ? fmtBytes(ctx.bytes) + ' / ' + fmtBytes(ctx.total)
          : fmtBytes(ctx.bytes)
        const speed = ctx.showSpeed ? fmtSpeed(ctx.speed) : ''
        return {
          name: task.label || '下载中...',
          meta: speed ? size + ' · ' + speed : size,
        }
      },
      /** No byte stream at all: phase text plus elapsed time, newest log line. */
      install(task, ctx) {
        return {
          name:
            task.phase === 'applying' ? '插件安装中...应用配置中...' : '插件安装中...下载中...',
          meta: ctx.elapsed + 's',
        }
      },
      /**
       * A package manager run (npm / pnpm / pip / docker pull …). It reports no
       * byte count, so the card carries a clock and a verb — never a percentage.
       * The verb comes from the command, because "插件安装中" is wrong for `npm
       * install` and "下载中" is wrong for `docker pull`.
       */
      pkg(task, ctx) {
        // `label` carries the matched verb from the host; the demo card has only
        // the raw command in `log`, so either is enough to pick the wording.
        const command = String(task.label || task.log || '')
        const what = /docker|ollama/i.test(command)
          ? '拉取镜像中...'
          : /pip|uv\b/i.test(command)
            ? '安装 Python 包中...'
            : '安装依赖中...'
        return { name: what, meta: ctx.elapsed + 's' }
      },
      /** A single page fetch: only a clock, because nothing is measurable. */
      fetch(task, ctx) {
        return { name: '正在抓取网页中...' + ctx.elapsed + 's', meta: '' }
      },
      /** A search: the query is the only useful thing to show. */
      search(task) {
        return { name: '正在搜索「' + (task.label || '…') + '」中...请稍后', meta: '' }
      },
    }

    /** Unknown shape: still show a card, just without a claim about progress. */
    function fallbackView(task, ctx) {
      return { name: '载入中...', meta: ctx.elapsed + 's' }
    }

    /**
     * Flatten one wire task into everything a card needs.
     *
     * Numbers are coerced once, here, so `Card` never re-parses `task.bytes` /
     * `task.total` and never risks computing a different percentage than the size
     * readout next to it.
     *
     * @param {object} task
     * @param {{showSpeed?: boolean}} [options]
     */
    function describe(task, options) {
      const ctx = {
        showSpeed: !options || options.showSpeed !== false,
        bytes: Number(task.bytes) || 0,
        total: Number(task.total),
        speed: Number(task.speed) || 0,
        elapsed: secs(task.elapsedMs),
      }
      ctx.hasTotal = Number.isFinite(ctx.total) && ctx.total > 0
      // Nothing measured yet and nothing moving: the transfer has not produced a
      // first byte count. `bytes` is 0 either because nothing has arrived or
      // because the host is deliberately withholding a preallocated size, so the
      // card says "preparing" instead of inventing a number.
      //
      // Deliberately NOT gated on `done`: a `run_in_background` download has
      // `done: true` from its first tick, because the tool call returned at once
      // while the job kept running. Gating on it hid "preparing" for exactly the
      // case it was written for — aria2c, which preallocates for a minute before
      // its first bitmap save. A genuinely finished task has bytes > 0 and never
      // reaches here; one that died at zero retires within a few ticks.
      ctx.preparing = ctx.bytes === 0 && ctx.speed === 0

      const build = VIEWS[task.kind] || fallbackView
      const { name, meta } = build(task, ctx)
      // Only downloads have a meaningful fraction; everything else stays
      // indeterminate even if the host happened to report a total.
      const percent =
        task.kind === 'download' && ctx.hasTotal
          ? clamp((ctx.bytes / ctx.total) * 100, 0, 100)
          : null

      return {
        name,
        meta,
        percent,
        determinate: percent !== null,
        log: logOf(task),
      }
    }

    // Stagger between cards so a stack lights up as a sequence rather than a
    // single flash. Kept short: five cards spend 220ms in total.
    const STAGGER_MS = 55

    function Card(props) {
      const task = props.task || {}
      const view = describe(task, { showSpeed: props.showSpeed })
      const percent = view.percent
      const phase = props.phase === 'out' ? 'out' : 'in'
      const delay = phase === 'in' ? Math.max(0, Number(props.index) || 0) * STAGGER_MS : 0

      return h(
        'div',
        {
          className: cx('ddp-card', 'ddp-ease-' + props.ease, 'ddp-anim--' + phase),
          style: delay ? { animationDelay: delay + 'ms' } : undefined,
        },
        h(
          'div',
          { className: 'ddp-row' },
          h('span', { className: 'ddp-name', title: view.name }, view.name),
          view.meta ? h('span', { className: 'ddp-meta' }, view.meta) : null,
        ),
        h(
          'div',
          { className: 'ddp-track' },
          h(
            'div',
            { className: 'ddp-clip' },
            h('div', {
              className: percent === null ? 'ddp-fill ddp-fill--indet' : 'ddp-fill',
              style: percent === null ? undefined : { width: percent.toFixed(2) + '%' },
            }),
          ),
          percent === null ? null : h('span', { className: 'ddp-tip' }, percent.toFixed(1) + '%'),
        ),
        view.log ? h('div', { className: 'ddp-log' }, view.log) : null,
      )
    }

