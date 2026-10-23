    // Drag session lives at module scope: there is exactly one overlay, and the
    // move/up listeners are attached to the window, not to the element.
    let dragSession = null

    function beginDrag(event) {
      if (!event || (event.button !== undefined && event.button !== 0)) return
      const el = event.currentTarget
      if (!el || typeof el.getBoundingClientRect !== 'function') return
      // Always measure the wrapper, never the element that was grabbed. The grip
      // sits 12px below the wrapper's top edge (6px tall + 6px margin) and is only
      // 56px wide, so taking the grip's own rect would make the overlay creep
      // upwards by 12px on every drag and would let the clamp believe the overlay
      // is 56px wide instead of 560px.
      const wrap = (typeof el.closest === 'function' && el.closest('.ddp-wrap')) || el
      if (!wrap || typeof wrap.getBoundingClientRect !== 'function') return
      const rect = wrap.getBoundingClientRect()
      dragSession = {
        el: wrap,
        startX: Number(event.clientX) || 0,
        startY: Number(event.clientY) || 0,
        originX: rect.left,
        originY: rect.top,
        width: rect.width,
        height: rect.height,
        moved: false,
        last: null,
      }
    }

    function clampInto(x, y, width, height) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 768
      // Keep at least 8px of the overlay on screen on every edge, so it can never
      // be dragged out of reach.
      const maxX = Math.max(8, vw - width - 8)
      const maxY = Math.max(8, vh - height - 8)
      const left = clamp(x, 8, maxX)
      const top = clamp(y, 8, maxY)
      return {
        x: Math.round(left),
        y: Math.round(top),
        // Half the width, so the drag renderer can place the CENTRE in pixels and
        // keep `translateX(-50%)` on the wrapper the whole time. Switching the
        // transform on drop (none → -50%) would shift the wrapper by half a card
        // for one transition while `left` slid the other way — the visible "jump
        // left, then snap back" after releasing the mouse.
        half: width / 2,
        // Where the card's CENTRE sits, as a percentage of the viewport. This is
        // what gets persisted: the renderer resolves it against the live window
        // size, so resizing keeps the relative position with no JS involved.
        pct: Math.round(((left + width / 2) / vw) * 10000) / 100,
      }
    }

    // Peek session at module scope: a remount keeps the same fake clock, so the
    // sample cards do not restart mid-hover. React state below still drives the
    // re-render; this object only supplies the seed and the start timestamp.
    const peekState = { on: false, at: 0 }

    function setPeek(on) {
      if (on && !peekState.on) peekState.at = Date.now()
      if (!on) peekState.at = 0
      peekState.on = on
    }

    // Hover intent. Even with the hit area bridged, a pointer can clip the edge
    // of the grip for one frame while travelling down; collapsing instantly makes
    // the cards flash. Keep the peek alive for a short grace period and cancel it
    // as soon as the pointer is back over the grip or the cards.
    const LEAVE_GRACE_MS = 180

    // While the window is being resized the cards would re-blur a large backdrop
    // on every frame. Dropping the filter for the duration of the gesture (and a
    // short tail after it) keeps a live resize responsive; the blur comes back
    // once the pointer stops moving the window edge.
    const RESIZE_IDLE_MS = 200
    let leaveTimer = 0

    function cancelLeave() {
      if (leaveTimer) clearTimeout(leaveTimer)
      leaveTimer = 0
    }

    function scheduleLeave(collapse) {
      cancelLeave()
      leaveTimer = setTimeout(() => {
        leaveTimer = 0
        collapse()
      }, LEAVE_GRACE_MS)
    }

