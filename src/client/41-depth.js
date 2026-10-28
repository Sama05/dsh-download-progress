    /* ---------------- depth progress switch (client -> host) ---------------- */

    /**
     * The write half of the depth-progress switch.
     *
     * The preference itself lives in localStorage with the rest of the settings,
     * because that is where this plugin's settings have always lived and it keeps
     * the read path synchronous. But the sensor lives in the **host process**, and
     * only the host can install it — so every change is pushed over the write
     * route, and once more on mount, because the host may have restarted since
     * the user last touched the toggle.
     *
     * Deliberately fire-and-forget: a failed push means the card quietly falls
     * back to what it showed before, which is a worse card, not a broken plugin.
     * There is no error banner for this — a user who moved a switch does not want
     * a network dialog about it.
     */
    const CONFIG_ROUTE = '/download-progress/config'

    /**
     * @param {unknown} enabled
     * @param {typeof fetch} [impl] injectable for tests only
     * @returns {Promise<boolean>} whether the host accepted it
     */
    async function pushDepthSwitch(enabled, impl) {
      const body = JSON.stringify({ depthProgress: enabled === true })
      // A host without `fetch` (or a sandbox like the smoke harness) has no way
      // to accept the switch. Report that instead of throwing out of a `useEffect`,
      // where React would turn it into a render error.
      const doFetch =
        typeof impl === 'function'
          ? impl
          : typeof window.fetch === 'function'
            ? window.fetch.bind(window)
            : null
      if (!doFetch) return false
      try {
        const url = new URL(CONFIG_ROUTE, window.location.origin).toString()
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          // The route answers 204 with no body; asking for JSON would throw on
          // a perfectly successful response.
          cache: 'no-store',
        })
        return Boolean(res && res.ok)
      } catch {
        return false
      }
    }

    /**
     * Keep the host's switch equal to the stored preference.
     *
     * Called once on mount and on every change. The mount push is what makes a
     * host restart converge: the preference is in localStorage, the sensor is
     * not, and nothing else would tell the host.
     *
     * @param {boolean} enabled
     */
    function useDepthSwitch(enabled) {
      React.useEffect(() => {
        pushDepthSwitch(enabled)
      }, [enabled])
    }
