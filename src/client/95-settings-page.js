    /* ---------------- settings page view ---------------- */

    function SettingRow(props) {
      return h(
        'div',
        { className: 'ddp-set-row' },
        h(
          'div',
          { className: 'ddp-set-text' },
          h('div', { className: 'ddp-set-label' }, props.label),
          props.hint ? h('div', { className: 'ddp-set-hint' }, props.hint) : null,
        ),
        h('div', { className: 'ddp-set-ctrl' }, props.children),
      )
    }

    function toggleRow(props) {
      return h(
        SettingRow,
        { label: props.label, hint: props.hint },
        h('input', {
          type: 'checkbox',
          className: 'ddp-set-check',
          checked: !!props.checked,
          'aria-label': props.label,
          onChange: (event) => props.onChange(!!(event.target && event.target.checked)),
        }),
      )
    }

    /**
     * A labelled <select> row.
     *
     * Four settings differ only in their data (value, label, option list, what
     * they write back), so the markup lives here once instead of being repeated
     * with copy-pasted `className` / `aria-label` / `onChange` wrappers.
     *
     * @param {{label: string, hint?: string, aria: string, value: unknown,
     *          options: {value: string, label: string}[],
     *          onChange: (value: string) => void}} props
     */
    function selectRow(props) {
      return h(
        SettingRow,
        { label: props.label, hint: props.hint },
        h(
          'select',
          {
            className: 'ddp-set-select',
            value: String(props.value),
            'aria-label': props.aria,
            onChange: (event) => props.onChange(event.target.value),
          },
          props.options.map((option) =>
            h('option', { key: option.value, value: option.value }, option.label),
          ),
        ),
      )
    }

    /** Row-count choices for the "max visible cards" setting. */
    const ROW_COUNTS = [1, 2, 3, 4, 5, 6]

    function SettingsPage() {
      const settings = useSettings()
      const set = writeSettings
      // The preference is in localStorage; the sensor is in the host process.
      // This is the only thing that carries one to the other, and it fires on
      // mount as well, so a host restart converges without the user retouching
      // the switch.
      useDepthSwitch(settings.depthProgress)

      return h(
        'div',
        { className: 'ddp-set' },
        toggleRow({
          label: '显示下载进度浮层',
          hint: '关闭后不再轮询状态接口，也不渲染任何浮层。',
          checked: settings.enabled,
          onChange: (next) => set({ enabled: next }),
        }),
        selectRow({
          label: '显示方式',
          hint: '「浮层」是悬在页面上方的卡片堆（原有样式）；「简易条」是嵌在对话框那一行的细进度条，只显示当前会话、只带速度，悬停看百分比；「两者都显示」则同时出现。',
          aria: '显示方式',
          value: settings.display,
          options: DISPLAY_LABELS,
          onChange: (value) => set({ display: value }),
        }),
        toggleRow({
          label: '显示下载速度',
          hint: '在已下载大小旁边显示当前速度，例如 3.2 MB/s。',
          checked: settings.showSpeed,
          onChange: (next) => set({ showSpeed: next }),
        }),
        toggleRow({
          label: '启用深度进度（需重启应用生效）',
          hint: '关闭（默认）：能落盘的下载（curl / wget / aria2c / git clone / BITS）靠文件大小算进度；网页抓取、搜索这类不落盘的仍然只有计时。打开后，网页抓取与搜索也有百分比——插件在宿主进程里包住 HTTP 客户端的 fetch，把响应体读成可计数的流。⚠ 这个开关改完要重启应用才生效：包装必须在 HTTP 客户端模块第一次被加载时注入，而宿主启动早期就加载了它，已经加载过的模块无法回头再包。拨开关当下不会有任何变化，重启后才开始记字节。',
          checked: settings.depthProgress,
          onChange: (next) => set({ depthProgress: next }),
        }),
        toggleRow({
          label: '调试模式（显示模拟数据）',
          hint: '打开后，没有真实下载时浮层会显示一条可拖动的把手；鼠标移到把手上会展开 5 张模拟卡片，用来调 UI。关闭后只显示真实下载，没有任何占位内容。',
          checked: settings.debugMode,
          onChange: (next) => set({ debugMode: next }),
        }),
        toggleRow({
          label: '只看当前会话的下载',
          hint: '关闭（默认）：所有会话的下载按会话分块，堆叠在同一个浮层里。打开：只显示当前正打开的会话的下载，切换到别的会话就跟着换成那个会话的进度。当前会话没有下载时浮层不显示。',
          checked: settings.currentOnly,
          onChange: (next) => set({ currentOnly: next }),
        }),
        selectRow({
          label: '新任务的排列位置',
          hint: '同时有多个下载时，最新出现的条目放在列表顶部还是底部。',
          aria: '排列顺序',
          value: settings.order,
          options: [
            { value: 'newest-first', label: '最新在前' },
            { value: 'oldest-first', label: '最新在后' },
          ],
          onChange: (value) => set({ order: value }),
        }),
        selectRow({
          label: '主题',
          hint: '「跟随系统」直接沿用 DSH 当前主题；亮色/暗色只作用于浮层。新增主题只需在 client.js 的 THEMES 里加一项，这个下拉会自动出现新选项。',
          aria: '主题',
          value: settings.theme,
          options: allThemes().map((theme) => ({ value: theme.id, label: theme.label })),
          onChange: (value) => set({ theme: value }),
        }),
        selectRow({
          label: '出现动画',
          hint: '浮层出现 / 收起时的动效。「CRT 开关机」是从一条亮线展开、收起时再缩成亮线消失；「水波纹」是从卡片中心涌出一圈光；「无动画」则瞬间出现。',
          aria: '出现动画',
          value: settings.enterAnim,
          options: ENTER_ANIMS.map((anim) => ({ value: anim.id, label: anim.label })),
          onChange: (value) => set({ enterAnim: value }),
        }),
        selectRow({
          label: '最多同时显示条数',
          hint: '超出的条目在浮层内滚动查看。',
          aria: '最多同时显示条数',
          value: settings.maxVisible,
          options: ROW_COUNTS.map((n) => ({ value: String(n), label: n + ' 条' })),
          // The select yields a string; the setting is a number.
          onChange: (value) => set({ maxVisible: Number(value) }),
        }),
        h(
          SettingRow,
          {
            label: '浮层位置',
            hint: '有下载时直接拖动卡片即可换位置，松手记住；「重置位置」回到顶部居中。',
          },
          h(
            'button',
            {
              type: 'button',
              className: 'ddp-set-btn',
              onClick: () => set({ x: null, y: DEFAULT_Y }),
            },
            '重置位置',
          ),
        ),
        h(
          'div',
          { className: 'ddp-set-note' },
          '调试模式关闭（默认）时，浮层只显示真实下载；没有下载就完全不显示，不占位、不误导。',
          h('br'),
          '打开调试模式后，没有下载时会出现一条把手，鼠标移到把手上展开 5 种形态的示例卡片（下载 / 安装 / 抓取 / 搜索 / 安装依赖），用来比对 UI；',
          '一旦有真实下载，示例自动让位，有几个任务就只显示几张卡片。',
          h('br'),
          '能拿到真实进度：curl / wget / Invoke-WebRequest -OutFile / git clone 把文件落盘到本地时——',
          '显示已下载大小、总大小与实时速度，悬停进度条可看百分比。',
          h('br'),
          '拿不到字节数：不落盘的下载、网页抓取、搜索、模型流式输出——',
          '这些显示不确定进度条与已用时。',
        ),
      )
    }

