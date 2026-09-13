# deck-api · 播放器 API

> 实现：`lib/player/deck.js`。规则见 `.claude/rules/player.md`。

## 页面接入

```html
<script src="<相对>/lib/vendor/gsap/gsap.min.js"></script>
<script src="<相对>/lib/theme/theme.js"></script>
<script src="<相对>/lib/player/deck.js"></script>
<script>
  window.SCREEN_TIMELINES = {
    s2: function (ctx) {
      var tl = gsap.timeline();
      tl.from(ctx.q(".s-title"), { y: 20, opacity: 0, duration: .5, ease: "var(--ease-out)" });
      return tl;                 // 必须返回 timeline
    }
  };
  deck.init();
</script>
```

## window.SCREEN_TIMELINES

- 键 = 屏的 `data-tl` 属性值；值为 `function(ctx) -> gsap.timeline`。
- `ctx`：`{ el, q(sel), qAll(sel), count(sel, to, opts) }`。
  - `q/qAll` 只在屏内查询。
  - `count` 数字滚动，返回 gsap tween，`tl.add(ctx.count(...), pos)` 使用；`opts: {to, duration, ease, dec, sep}`。

## window.deck API

| 方法 | 说明 |
|---|---|
| `deck.init()` | 初始化：收集 `.screen`、建导航、绑键盘。页面必须在 SCREEN_TIMELINES 定义后调用 |
| `deck.init({ mode:'shell', planEl, planUrl })` | 总控容器模式（见下「总控容器模式」） |
| `deck.next()` / `deck.prev()` | 下一屏 / 上一屏（门控） |
| `deck.jump(i)` | 跳第 i 屏 |
| `deck.nextChapter()` / `deck.prevChapter()` | 下一章 / 上一章（读 deck-config 的 next/prev） |
| `deck.goFile(file, dir)` | 跳指定章节文件 |
| `deck.showPage(i)` / `deck.loadPage(i)` | 总控模式：切到第 i 页 / 预加载第 i 页（iframe） |

## 屏与门控

- 屏：`<section class="screen" id="..." data-tl="key">`。无 `data-tl` 的屏 = 无动画屏，↓ 即切。
- 视频门控：屏内 `<video data-gate src="...">`；`data-gate-autoplay` 进入即自动播；播放中再 ↓ 跳过。
- 状态机：`idle → playing → done`；`↓` 在 idle 播放动画/视频，playing 忽略（防连击），done 才切屏。
- 进度条与章节 tab 由 deck 渲染，状态机驱动（不依赖 scroll）。
- gsap 缺失时 `data-tl` 屏直接 done，不白屏。

## 总控容器模式（shell）

> 把多个单页拼成一场演示：总控页 iframe 加载各页 + 预加载下一页（隐藏）+ 翻页切换可见性 →
> 无白屏无缝衔接；iframe 不销毁，翻回保留状态；**导航顺序由编排配置决定，单页零改动可复用**。

### 接入（总控页，如 `course/deck-shell.html`）

```html
<script type="application/json" class="deck-plan">
{ "id": "cbec-full", "title": "跨境电商 · 完整版",
  "pages": [
    { "file": "cases/cbec/demo/p0-prologue.html", "title": "序 · 三个时代同时存在" },
    { "file": "cases/cbec/demo/p1-west-board.html", "title": "01 · 欧美棋盘" }
  ] }
</script>
<script src="<相对>/lib/theme/theme.js"></script>
<script src="<相对>/lib/player/deck.js"></script>
<script> deck.init({ mode: 'shell', planEl: '.deck-plan' }); </script>
```

### 编排配置（plan.json）

- `pages[].file` **相对总控页**；`title` 用于顶栏 tab。不同编排 = 不同 plan.json，单页不改。
- 示例：`course/plans/cbec-full.json`、`course/plans/health-fmc-full.json`。
- 改 plan.json 后运行 `scripts/embed-deck-plan.js <plan.json> <总控页> --write` 重新内嵌（file:// 零 fetch）。
- http 下可 `?plan=plans/health-fmc-full.json` 切换编排（file:// 自动回退内嵌）。

### 运行时行为

| 交互 | 行为 |
|---|---|
| 页内 `↓`/`↑`/滚轮/触摸 | 页内屏级翻页（页自己的 deck 状态机） |
| 最后一屏 `↓` / 页内 `→`/`←` | 按 **plan 顺序**切页（忽略页内 deck-config 的文件跳转） |
| 总控顶栏 tab / 底部 ‹ › 按钮 | 直接切页 |
| 首次展示某页 | 重演入场动画（预加载已渲染好内容 → 无白屏） |
| 翻回已看过的页 | 保留原状态（iframe 不销毁） |
| 总控主题按钮 | 同步广播所有 iframe 页面 |

### 页侧兼容（单页模式不变）

- 页面在 iframe 内被加载时：`deck.js` 自动进入容器子模式——不渲染自身顶栏/进度条（由总控提供），
  翻章请求改发 postMessage 给总控；**独立打开时行为与之前完全一致**。
- 页内 `deck-config` 保留（单页独立导航仍然可用），总控场景下其 next/prev 仅作参考、不生效。

### 通信协议（postMessage，跨源/跨 file:// 均可用）

| 方向 | type | 载荷 |
|---|---|---|
| 页 → 总控 | `deck-progress` | `{ index, total, state }` 屏级进度 |
| 页 → 总控 | `deck-go` | `{ file, dir }` 翻章请求（dir>0 下页 / <0 上页） |
| 总控 → 页 | `deck-register` | 确认容器模式（页收到后才接管翻章） |
| 总控 → 页 | `deck-cmd` | `{ cmd: 'next'|'prev'|'jump'|'home'|'end'|'theme', index?, theme? }` |
