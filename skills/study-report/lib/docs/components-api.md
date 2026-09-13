# components-api · 组件 API

> 实现：`lib/components/*`。规则见 `.claude/rules/components.md`。

## chat-window · 仿微信一对一

```html
<link rel="stylesheet" href="<相对>/lib/components/chat-window.css">
<script src="<相对>/lib/components/chat-window.js"></script>
<chat-window data-chat='{...}'></chat-window>        <!-- 短数据 -->
<!-- 长数据 -->
<script type="application/json" id="chat-x"> {...} </script>
<chat-window data-ref="#chat-x"></chat-window>
```

JSON schema：

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` / `subtitle` | string | 顶部条标题 / 副题 |
| `msgs[]` | array | 消息 |
| `footer` | string | 底部脚注 |

`msgs[]` 元素（`side: 'in'|'out'`，`avatar` 头像文字）：

| type | 字段 | 渲染 |
|---|---|---|
| `time` | text | 居中时间 |
| `text` | text, bold? | 气泡文本（\n 换行，bold 加粗） |
| `transfer` | text, amount | 转账卡（金额绿色） |
| `divider` | text | 剧情推进分隔线 |
| `image` | src, caption? | 气泡内图片 |
| `quote` | text, source? | 引语强调 |

## group-chat · 仿企业微信电脑端群聊

```html
<group-chat data-chat='{...}'></group-chat>
```

JSON schema：`{ group, subtitle, members:[{name,avatar,role}], msgs:[...], footer }`

`msgs[]` 元素：`{ name, avatar, type }`
- `type:'text'`：`text`，文本内 `@成员名` 自动高亮提及
- `type:'card'`：`title, sub, tag` 名片卡

## logic-flow · 逻辑图（mermaid 封装）

> 通用规则见 `.claude/rules/logic-diagram.md`。mermaid 需先加载：`<script src="<相对>/lib/vendor/mermaid/mermaid.min.js"></script>`

```html
<link rel="stylesheet" href="<相对>/lib/components/logic-flow.css">
<script src="<相对>/lib/components/logic-flow.js"></script>
<!-- 结构化 JSON（推荐） -->
<logic-flow data-json='{
  "dir": "LR",
  "nodes": [ { "id": "hw", "label": "AI学习机\n几十亿研发", "cls": "warn" } ],
  "edges": [ { "from": "hw", "to": "sink", "label": "用户落灰" } ]
}'></logic-flow>
<!-- 进阶：直接写 mermaid 原文 -->
<logic-flow data-mermaid='flowchart LR
  A["题库"] --> B["大模型"]'></logic-flow>
```

JSON schema：

| 字段 | 类型 | 说明 |
|---|---|---|
| `dir` | string | `LR`（左右）/ `TB`（上下），默认 LR |
| `nodes[]` | array | `id` 节点 key、`label` 显示文本（`\n` 换行）、`cls` 节点配色 |
| `edges[]` | array | `from`/`to` 节点 id、`label` 边标签、`dotted` 虚线 |

`cls` 可选值（配色随 token，双主题自适应）：`warn`（红·卡点/警示）/ `ok`（绿·解法/通过）/ `brand`（金·主角/核心）/ `sub`（紫·次级/支撑）/ `plain`（灰·默认）。

特点：色全部读 `var(--*)`（getComputedStyle），`html[data-theme]` 变化自动重绘（MutationObserver）；mermaid 缺失时降级显示原文。

## 组件纪律

- CSS 零硬编码色，只用 `var(--*)`（含 `--chat-*` 组件 token），双主题自适应。
- 不依赖 fetch / module，file:// 可用。
- 需要新组件：先在 `.claude/rules/components.md` 登记 → 定义 schema → 实现 → 在 smoke.html 冒烟。
