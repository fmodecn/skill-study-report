---
name: study-report
description: "学习复盘报告：自动采集近 48h 全部 Agent 工作痕迹（Claude Code/Codex/Trae/WorkBuddy/OpenClaw/元宝/Hermes/工作区）→ 三问追问（一次呈现三问，支持一次性连答：三段用 --- 分隔或 JSON；缺项再逐问补一轮）感受 → 生成 skill-present 级 HTML 复盘 PPT → Storage+Gogs 双通道发布。适用：(1) 培训/研修结营复盘 (2) 数字生命工作总结 (3) 一键转发给学员 Agent 代跑全流程。"
description_en: "Learning retrospective: auto-collect 48h of all Agent work traces, ask the user three reflection questions, build a skill-present-grade HTML PPT report, and publish via Storage+Gogs dual channels. Triggers: training retrospective, agent work summary, forwardable one-click skill."
---

# Study Report — 学习复盘报告技能

> 装给任何 Agent（Claude Code / Codex / WorkBuddy / Trae / Hermes / OpenClaw / 元宝）：
> **自动采集近两天全部 Agent 工作痕迹 → 追问用户感受 → 生成 HTML 复盘报告 PPT → Storage+Gogs 双通道发布。**

## 六段流程（严格按序执行）

### 第 0 段 · 安装前置自检（borrow 07-git.md 已验证链路）

```bash
node <skill_dir>/scripts/precheck.mjs
```

按序自检三环节，打印「安装体检表」，任一环节不通按提示走恢复流程：

1. **平台身份**：读 `~/.fmode/config/user.json` 的 **fmodeApiToken**（真实字段名，非 sessionToken）→ HEAD 探测平台可达
2. **Git 账户**（幂等，07-git.md 已验证链路）：`POST server.fmode.cn/api/functions {token, path:"/gogs/admin/proxy", params:{method:"POST", path:"/admin/users", body:{...}}}` → **201 新建 / 200 幂等返回新 token.sha1**（忘密码不找回，重调即得）；401/209 → 走「对话式验证码登录」恢复（手机号 → VerifyCode → 换 sessionToken）
3. **Storage 能力**：探测 obsutil config / OBS_AK 环境变量；无 → **不阻塞**（报告走 Gogs 降级通道），提示可选配置

### 第 1 段 · 采集（近 48h 全量扫描，跨 Agent 工具）

```bash
node <skill_dir>/scripts/collect.mjs --hours 48 --out /tmp/study-report-collect.json
```

所有工具路径**探测存在才扫**：Claude Code（`~/.claude/projects/*/*.jsonl`）、Codex、WorkBuddy、Trae、OpenClaw、元宝、Hermes Agent（`~/.fmode-harness-agent/`）、工作区产出物（`~/projects`、`~/git-repos`、`~/Desktop` 48h 内 .md/.html/.pdf/.docx/.xlsx）。

产出**采集清单**（每条：来源工具/时间/类型/摘要/产出物路径/URL）——**先给用户看**，缺哪类工具提示用户确认路径，不阻塞。

### 第 2 段 · 追问（采集完成后，三轮固定问题）

```bash
node <skill_dir>/scripts/ask.mjs --collect /tmp/study-report-collect.json --answers /tmp/study-report-answers.json
```

- **第一问·过去**：企业之前 AI 落地**不够原生、不够性感**的地方？痛点或疑惑？
- **第二问·现在**：这两天**具体感受与收获**？（成果已从采集拿到，只问感受 + 哪个项目有感觉）
- **第三问·未来**：学到的细节之后，**想回企业落地或探索的方向**？

口述与采集素材自动**关联标记**（说到某项目 → 引用该 session/文件证据）。**用户不答 → 用采集数据先行出报告，标注【待补充：用户口述】**，不阻塞。

### 第 3 段 · 报告（HTML PPT，skill-present 标准）

```bash
node <skill_dir>/scripts/build-report.mjs --collect /tmp/study-report-collect.json \
  --answers /tmp/study-report-answers.json --name "姓名" --enterprise "企业名" --out /tmp/study-report-out
```

≥10 屏结构：封面（姓名/企业/日期）→ 48h 数据全景（数字动画/工具分布）→ 交付物墙（HTML 用 iframe 嵌套，在线项目标记可嵌）→ 精选工作时刻线 → 过去痛点 → 两天感受（关联素材）→ 未来方向 → 数据附录 → 收口金句。
**lib 全套独立复制**（deck.js/tokens/base.css/canvas-scale/gsap 逐文件校验，v2.4.1 base.css 缺失教训）；数据优先/证据链/来源标注。

### 第 4 段 · 发布（双通道）

```bash
node <skill_dir>/scripts/publish.mjs --dir /tmp/study-report-out --name "姓名" \
  --gogs-token <precheck所得token> --gogs-user <precheck所得用户名>
```

1. **Storage（主）**：`uploader.mjs put` → `study-report/<姓名>-<日期>/report.html` → 公开 URL（上传后 HEAD 验证）
2. **Gogs（降级/并行）**：自检 token 建 `study-report-<姓名拼音>` 仓 → push 报告+素材（ls-remote 验证 SHA）
3. **ZIP**：打包 → Storage `downloads/skill-study-report.zip`（CDN 映射探测，未映射给 Storage 直链）
4. **状态门禁分别报告**：Storage/Gogs/ZIP 三个独立状态；Storage 缺权限走 Gogs，Gogs 也失败 → 本地文件路径 + 手动上传指引。**不伪造任何发布结果。**

### 第 5 段 · 交付话术

发布完成后把两条 URL（Storage + Gogs）和 ZIP 链接都给用户，附 README 中的「一键转发话术」。

## 凭据纪律（零暴露）

- fmodeApiToken / Gogs token / STS / AK/SK **只运行时读取，绝不写入仓库、日志、报告或对话**
- precheck/publish 输出只显示 token 尾 4 位
- 不伪造任何采集/发布结果；失败如实报告并给恢复指引

## 故障对照

| 症状 | 根因 | 对策 |
|---|---|---|
| precheck 环节1 ❌ | user.json 无 fmodeApiToken | 登录 FMODE Studio 保存配置，或对话式验证码登录 |
| precheck 环节2 401/209 | sessionToken 失效 | 对话式验证码登录恢复（07-git.md 标准节） |
| precheck 环节3 🟡 | 无 OBS 凭据 | 不阻塞——Gogs 降级通道；可选按 skill-storage init 向导配置 |
| collect 全 0 条 | 工具路径未覆盖 | 用 `STUDY_REPORT_EXTRA_SCAN_ROOT` 追加扫描根；确认工具安装路径 |
| build-report 报 lib 缺失 | 安装不完整 | 重新克隆仓库（lib 逐文件校验会精确报缺哪个） |
| publish Storage 🟡 | 凭据链 4 级全空 | 走 Gogs 通道；两者都失败给本地路径+手动上传指引 |
| CDN ZIP 404 | fmode.cn/downloads/ 源站未映射 | 用返回的 Storage 直链；官方映射后自动生效 |
