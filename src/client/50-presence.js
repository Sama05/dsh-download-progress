    /* ---------------- enter / exit presence ---------------- */

    // Keeps a component mounted long enough to play its exit animation. Real
    // tasks and peeked samples both go through this, so the sample cards move
    // exactly like genuine downloads.
    function usePresence(show, ms) {
      const [visible, setVisible] = React.useState(!!show)
      const [leaving, setLeaving] = React.useState(false)

      React.useEffect(() => {
        if (show) {
          setVisible(true)
          setLeaving(false)
          return undefined
        }
        setLeaving(true)
        const timer = setTimeout(() => {
          setVisible(false)
          setLeaving(false)
        }, ms)
        return () => clearTimeout(timer)
      }, [show, ms])

      return { visible, leaving }
    }

