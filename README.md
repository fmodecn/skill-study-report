# skill-study-report · 学习复盘报告技能 📊

> **把一个学员近 48h 的全部 Agent 工作痕迹，变成一份可转发的 HTML 复盘报告 PPT**——自动采集 → 三问追问 → skill-present 级报告 → Storage+Gogs 双通道发布。
> 装给任何 Agent（Claude Code / Codex / WorkBuddy / Trae / Hermes / OpenClaw / 元宝）都能跑。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 解决什么

培训/研修结束，学员两天里在 N 个 Agent 工具里干了大量活，但复盘要人肉截图拼 PPT。本技能一条流水线搞定：

```
采集（48h 跨工具全量扫描，探测存在才扫）
  → 追问（三问：过去痛点 / 现在感受 / 未来方向；口述自动关联采集证据）
  → 报告（≥10 屏 HTML PPT：数据全景/交付物墙/时刻线/三问/附录，数字动画+证据链）
  → 发布（Storage 主 + Gogs 降级/并行 + ZIP 分发，状态门禁分别报告）
```

## 三分钟跑通

```bash
# 1. 安装自检（打印安装体检表：平台身份 / Git 账户 / Storage 能力）
node skills/study-report/scripts/precheck.mjs

# 2. 采集近 48h 全部 Agent 痕迹
node skills/study-report/scripts/collect.mjs --hours 48 --out /tmp/study-report-collect.json

# 3. 三问追问（用户不答可 --non-interactive，报告标注【待补充】）
node skills/study-report/scripts/ask.mjs --collect /tmp/study-report-collect.json --answers /tmp/study-report-answers.json

# 4. 生成报告（skill-present 全套 lib 独立复制 + 数据注入）
node skills/study-report/scripts/build-report.mjs --collect /tmp/study-report-collect.json \
  --answers /tmp/study-report-answers.json --name "姓名" --enterprise "企业名" --out /tmp/study-report-out

# 5. 双通道发布（Storage 主 + Gogs 降级/并行 + ZIP）
node skills/study-report/scripts/publish.mjs --dir /tmp/study-report-out --name "姓名"
```

发布结束打印三通道状态门禁（✅/🟡 各自独立，不伪造成功），交付两条 URL + ZIP 链接。

## 安装（引用 07-git 自检）

### Claude Code / Codex

```bash
git clone https://git.fmode.cn/fmode/skill-study-report.git
cp -r skill-study-report/skills/study-report ~/.claude/skills/    # 或 ~/.codex/skills/
```

装完先跑 `precheck.mjs`：它按 **fmode-studio 07-git.md 已验证链路**自检——
① 平台身份（`~/.fmode/config/user.json` 的 `fmodeApiToken`）→ ② Git 账户（云函数幂等开户+补发 token，忘密码不找回、重调即得）→ ③ Storage 能力（可选，缺省走 Gogs 降级）。
任一环节 ❌ 按体检表提示走「对话式验证码登录」恢复后重跑。

### WorkBuddy / Hermes / Trae / 其他

```bash
git clone https://git.fmode.cn/fmode/skill-study-report.git
cp -r skill-study-report/skills/study-report <你的工具技能目录>/study-report
```

读 `skills/study-report/SKILL.md`（六段流程）按工具规范并入。本仓库同时发布 ZIP：`https://fmode.cn/downloads/skill-study-report.zip`（或发布脚本输出的 Storage 直链），解压后把 `skills/study-report` 复制进技能目录即可。

## 一键转发话术（复制发给学员的 Agent）

```text
请安装并执行 study-report 技能，为我生成近 48h 学习复盘报告：

1. 下载安装包：https://fmode.cn/downloads/skill-study-report.zip
   （若上面 404，用发布时给出的 Storage 直链；或 git clone https://git.fmode.cn/fmode/skill-study-report.git）
2. 解压后把 skills/study-report 复制到你的技能目录
3. 按顺序执行 SKILL.md 六段流程：
   precheck.mjs（安装自检）→ collect.mjs（48h 采集）→ ask.mjs（三问向我追问，逐问等我回答）
   → build-report.mjs（生成报告）→ publish.mjs（Storage+Gogs 双通道发布）
4. 我的姓名是【____】，企业是【____】。发布完成后把全部 URL 发给我。
注意：全程中文；凭据零暴露；任何环节失败如实报告，不要伪造成功。
```

## 报告结构（≥10 屏）

封面（姓名/企业/日期）→ 48h 数据全景（会话数/工具分布/产出物，数字动画）→ 交付物墙（HTML 用 iframe 嵌套展示；在线项目明确标记可嵌）→ 精选工作时刻线 → 过去痛点（第一问）→ 两天感受（第二问+关联素材）→ 未来方向（第三问）→ 数据附录（可溯源明细）→ 收口金句。
视觉/播放体系为 **skill-present 全套 lib 独立复制**（deck.js / canvas-scale / tokens+base 主题 / gsap，逐文件校验复制——v2.4.1 base.css 缺失教训），`file://` 双击可开。

## 凭据纪律

- `fmodeApiToken` / Gogs token / OBS AK/SK **零暴露**：运行时读取，输出只见尾 4 位；绝不入仓库/日志/报告
- Storage 凭据复用 [skill-storage](https://git.fmode.cn/fmode/skill-storage) 诚实 4 级链；缺省不阻塞（Gogs 降级）
- 状态门禁分别报告：Storage/Gogs/ZIP 三通道独立 ✅/🟡；**不伪造任何采集与发布结果**

## FAQ

**Q：学员机器上没有任何 OBS 配置能跑吗？**
能。precheck 环节 3 是 🟡 不阻塞，报告走 Gogs 降级通道；两个通道都失败时给本地文件路径 + 手动上传指引。

**Q：学员不回答三问怎么办？**
报告照常生成，对应页标注【待补充：用户口述】，采集数据先行。`ask.mjs --non-interactive` 可完全跳过追问。

**Q：没装过 Codex/Trae 等工具会不会报错？**
不会。所有工具路径**探测存在才扫**，未检出的工具列入「待确认」清单提示，不阻塞。

**Q：报告里的数字真实吗？**
全部来自本机采集清单（`report-data.json` 随报告归档），无任何估算或编造；采集不到就显示 0 并注明。

**Q：ZIP 的 fmode.cn/downloads/ 链接 404？**
CDN 源站映射未配置时，发布脚本会自动探测并回退 Storage 直链——以 `publish.mjs` 实际输出为准。

## License

MIT
