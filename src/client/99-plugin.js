    /* ---------------- plugin ---------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const existing = document.getElementById('dsh-download-progress-style')
          if (existing) existing.remove()
          const style = document.createElement('style')
          style.id = 'dsh-download-progress-style'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            const node = document.getElementById('dsh-download-progress-style')
            if (node) node.remove()
          }
        })

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-download-progress', order: 900 },
            Overlay,
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-download-progress',
              order: 60,
              label: () => '下载进度条',
            },
            SettingsPage,
          ),
        )

        // The composer's tool row — the line that carries the permission chip.
        // It is a LIST slot: several plugins park compact chips here, so the
        // entry is ordered behind the ones already known to live here
        // (credits at 4, the skills chip at 1000) and is free to be pushed
        // further back by anything that picks a higher order later. The bar
        // itself never grows, so sharing the row costs a neighbour nothing.
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'dsh-download-progress', order: 2000 },
            InlineBar,
          ),
        )
      },
    }
  },
})

