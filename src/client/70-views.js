    /* ---------------- overlay view ---------------- */

    /**
     * Per-kind headline + meta builders.
     *
     * Before this table each shape was another `if` block repeating the same
     * `log: String(task.log || '')` and the same `elapsed + 's'`; adding a shape
     * meant touching four places. Now a shape is one entry, and anything a
     * builder does not return falls back to the shared values below.
     *
     * Builders read `ctx`, never `task`: `describe()` is the one place allowed to
     * touch the wire shape (CONTRACT.md, "谁是 adapter"). A builder reaching for
     * `task.staged` would be a second reader of the wire, and a field renamed on
     * the host would then break two places instead of one.
     */
    const VIEWS = {
      /** Real bytes: size, optional total, optional rate. */
      download(ctx) {
        if (ctx.unresolved) return { name: '载入中...', meta: ctx.elapsed + 's' }
        // The downloader writes its bytes to a staging file and renames them onto
        // the target only at the end, so the target stays at 0 until the transfer
        // is over. A bar there would read 0 % for the whole download; the clock is
        // the only honest thing to show.
        if (ctx.staged) return { name: ctx.label || '下载中...', meta: ctx.elapsed + 's' }
        // No byte has been counted yet. For aria2c that is the preallocation
        // window, which can last a while on a large file: its bitmap does not
        // exist yet, so the host deliberately reports nothing rather than the
        // preallocated size. Saying "0 B / 7 GiB · 0 B/s" there is a claim the
        // plugin cannot back up, and it reads as a stalled download.
        if (ctx.preparing) return { name: ctx.label || '下载中...', meta: '准备中...' }
        const size = ctx.hasTotal
          ? fmtBytes(ctx.bytes) + ' / ' + fmtBytes(ctx.total)
          : fmtBytes(ctx.bytes)
        const speed = ctx.showSpeed ? fmtSpeed(ctx.speed) : ''
        return {
          name: ctx.label || '下载中...',
          meta: speed ? size + ' · ' + speed : size,
        }
      },
      /** No byte stream at all: phase text plus elapsed time, newest log line. */
      install(ctx) {
        return {
          name:
            ctx.phase === 'applying' ? '插件安装中...应用配置中...' : '插件安装中...下载中...',
          meta: ctx.elapsed + 's',
        }
      },
      /**
       * A package manager run (npm / pnpm / pip / docker pull …). It reports no
       * byte count, so the card carries a clock and a verb — never a percentage.
       * The verb comes from the command, because "插件安装中" is wrong for `npm
       * install` and "下载中" is wrong for `docker pull`.
       */
      pkg(ctx) {
        // `label` carries the matched verb from the host; the demo card has only
        // the raw command in `log`, so either is enough to pick the wording.
        const command = String(ctx.label || ctx.log || '')
        const what = /docker|ollama/i.test(command)
          ? '拉取镜像中...'
          : /pip|uv\b/i.test(command)
            ? '安装 Python 包中...'
            : '安装依赖中...'
        return { name: what, meta: ctx.elapsed + 's' }
      },
      /** A single page fetch: only a clock, because nothing is measurable. */
      fetch(ctx) {
        return { name: '正在抓取网页中...' + ctx.elapsed + 's', meta: '' }
      },
      /** A search: the query is the only useful thing to show. */
      search(ctx) {
        return { name: '正在搜索「' + (ctx.label || '…') + '」中...请稍后', meta: '' }
      },
    }

    /** Unknown shape: still show a card, just without a claim about progress. */
    function fallbackView(ctx) {
      return { name: '载入中...', meta: ctx.elapsed + 's' }
    }

    /**
     * 这一帧的能力状态，是四个已知值之一。
     *
     * 老 Host 不送 `capabilities`，那就按 `'off'` 处理：与「用户没开」同义，
     * 界面的说法仍然是「可以打开」，而不是「不支持」。反过来，任何不认识的值
     * 也退成 `'off'`，因为「去打开试试」在这三种说法里是最不容易误导人的。
     *
     * @param {unknown} capabilities
     * @returns {'off'|'ok'|'unavailable'|'degraded'}
     */
    function streamState(capabilities) {
      const value = capabilities && capabilities.stream
      if (value === 'ok' || value === 'unavailable' || value === 'degraded') return value
      return 'off'
    }

    /**
     * 一句「为什么没有百分比」。
     *
     * 只在确实拿不到分数时产出，而且只在**这条任务本来可以**有分数时才提到
     * 深度进度：给一个安装卡片说「打开深度进度吧」是在骗人，那条路本来就没有
     * 字节流。
     *
     * 四种状态必须是四种说法，因为它们对用户意味着完全不同的行动：
     *
     *   off          → 你能打开它
     *   ok           → 已经开着，在等字节（或正在建立连接）
     *   unavailable  → 开着也没用，这个环境不支持
     *   degraded     → 开了，但装不上，已降级
     *
     * 把 `unavailable` / `degraded` 说成「去打开」是这一层最容易犯的错：用户照做
     * 之后还是一样，只会认为插件坏了。
     *
     * @param {object} ctx
     * @returns {string}
     */
    function noPercentHint(ctx) {
      if (ctx.hasTotal) return ''
      // 磁盘采样的下载没有 total 只是「服务端没给 content-length」，深度进度
      // 也救不了它；安装、包管理更没有字节流可数。
      if (ctx.progressSource !== 'stream') return ''
      if (ctx.stream === 'ok') {
        return ctx.bytes === 0 ? '正在建立连接...' : ''
      }
      if (ctx.stream === 'unavailable') return '当前环境不支持深度进度'
      if (ctx.stream === 'degraded') return '深度进度开启失败，已降级为仅计时'
      return '打开「深度进度」可显示百分比'
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
        // The rest of the wire fields the builders used to read straight off
        // `task`. Copied, not proxied, so a builder cannot reach the object.
        kind: String(task.kind || ''),
        label: String(task.label || ''),
        phase: String(task.phase || ''),
        log: logOf(task),
        unresolved: task.unresolved === true,
        staged: task.staged === true,
        // Which layer is measuring this shape, and whether the measuring layer
        // that would help is on. The pair decides the "why no percentage" line.
        progressSource: String(task.progressSource || 'none'),
        stream: streamState(options && options.capabilities),
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
      // Why there is no score. Computed once here so every surface — the card and
      // the composer chip — says the same thing about the same state.
      ctx.hint = noPercentHint(ctx)

      const build = VIEWS[ctx.kind] || fallbackView
      const { name, meta } = build(ctx)
      // Only downloads have a meaningful fraction; everything else stays
      // indeterminate even if the host happened to report a total.
      const percent =
        ctx.kind === 'download' && ctx.hasTotal
          ? clamp((ctx.bytes / ctx.total) * 100, 0, 100)
          : // A `fetch` has bytes and a total once the stream sensor is on, and
            // it deserves the same bar a download gets — that is the whole point
            // of the switch. Without a total there is nothing to draw.
            ctx.kind === 'fetch' && ctx.hasTotal
            ? clamp((ctx.bytes / ctx.total) * 100, 0, 100)
            : null

      return {
        name,
        meta,
        percent,
        determinate: percent !== null,
        log: ctx.log,
        hint: ctx.hint,
        // One short label for where the number came from, empty when the number
        // needs no explanation (a disk-sampled download is the obvious case).
        sourceLabel:
          ctx.progressSource === 'stream' && ctx.stream === 'ok' ? 'HTTP 流观测' : '',
      }
    }

    // Stagger between cards so a stack lights up as a sequence rather than a
    // single flash. Kept short: five cards spend 220ms in total.
    const STAGGER_MS = 55

    function Card(props) {
      const task = props.task || {}
      const view = describe(task, {
        showSpeed: props.showSpeed,
        capabilities: props.capabilities,
      })
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
        // Why there is no percentage. Rendered only when `describe()` produced a
        // reason, so a working bar never grows an extra line.
        view.hint ? h('div', { className: 'ddp-hint' }, view.hint) : null,
        view.log ? h('div', { className: 'ddp-log' }, view.log) : null,
      )
    }

