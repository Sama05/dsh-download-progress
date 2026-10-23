    /* ---------------- sample data (shown only while peeking) ---------------- */

    // The overlay is hidden by default and only a thin handle is visible. Hovering
    // that handle reveals one card per shape the plugin can render, so the UI can
    // be inspected without starting a real download. Sample data is never
    // persisted and never mixed with real tasks: the moment a real task exists it
    // replaces the samples entirely.
    const FAKE_KINDS = ['download', 'install', 'fetch', 'search', 'pkg']

    /** Sample cards tick slower than real data: it is a still image, not a poll. */
    const SAMPLE_TICK_MS = 1000

    const FAKE_TOTAL = 29674910
    const FAKE_RATE = 3.4 * 1024 * 1024
    const FAKE_HOLD_MS = 1200
    const FAKE_LOG = [
      'Progress: resolved 128, reused 120, downloaded 8, added 8',
      'Progress: resolved 214, reused 198, downloaded 16, added 16',
      'Progress: resolved 356, reused 340, downloaded 16, added 16',
      'Packages: +16',
    ]

    function fakeTask(kind, elapsed) {
      const t = Math.max(0, Number(elapsed) || 0)
      const id = 'sample-' + kind

      if (kind === 'download') {
        const cycle = (FAKE_TOTAL / FAKE_RATE) * 1000
        const travelled = ((t % (cycle + FAKE_HOLD_MS)) / cycle) * FAKE_TOTAL
        // A little deterministic wobble so the speed readout looks alive
        // without making the bar jump backwards.
        const speed = FAKE_RATE * (1 + 0.08 * Math.sin(t / 850))
        return {
          id,
          kind: 'download',
          label: 'node-v20.11.0-win-x64.zip',
          log: 'https://registry.npmmirror.com/-/binary/node/v20.11.0/node-v20.11.0-win-x64.zip',
          bytes: Math.min(FAKE_TOTAL, Math.round(travelled)),
          total: FAKE_TOTAL,
          speed: Math.round(speed),
          elapsedMs: t,
        }
      }
      if (kind === 'install') {
        return {
          id,
          kind: 'install',
          phase: t > 6000 ? 'applying' : 'installing',
          log: FAKE_LOG[Math.floor(t / 1200) % FAKE_LOG.length],
          elapsedMs: t,
        }
      }
      if (kind === 'fetch') {
        return {
          id,
          kind: 'fetch',
          log: 'https://nodejs.org/dist/v20.11.0/SHASUMS256.txt',
          elapsedMs: t,
        }
      }
      if (kind === 'search') {
        return {
          id,
          kind: 'search',
          label: '下载进度条 插件开发',
          log: 'advanced_search · 下载进度条 插件开发 DSH cordis',
          elapsedMs: t,
        }
      }
      return {
        id,
        kind: 'pkg',
        log: 'python -m pip install --upgrade dsh-cli',
        elapsedMs: t,
      }
    }

    function useSampleTasks(active, startedAt) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (!active) return undefined
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), SAMPLE_TICK_MS)
        return () => clearInterval(timer)
      }, [active, startedAt])
      if (!active || !startedAt) return []
      return FAKE_KINDS.map((kind) => fakeTask(kind, Math.max(0, now - startedAt)))
    }

