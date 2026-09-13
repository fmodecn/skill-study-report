# manifest-schema · 两级索引 schema

> 权威源文档，规则见 `.claude/rules/index.md`。

## 课程级 `course/manifest.json`

```json
{
  "id": "hundun-aiceo",
  "course": "混沌AI院 · Day1 下午+晚上 案例大课",
  "version": "0.4",
  "themes": ["dark", "light"],
  "chapters": [
    {
      "id": "job-agent",
      "title": "蓝领招聘 · AI 复制知心大姐",
      "hook": "几百人拿着电话卷获客的行业，最强的经纪人，两年没打过一个拉新电话。",
      "outline": "cases/蓝领招聘-AI经纪人.md",
      "manifest": "cases/job-agent/manifest.json"
    }
  ]
}
```

## 案例级 `cases/<case>/manifest.json`

```json
{
  "id": "job-agent",
  "course": "hundun-aiceo",
  "title": "蓝领招聘案例 · 从几百人打电话到 AI 复制知心大姐",
  "outline": "../蓝领招聘-AI经纪人.md",
  "pages": [
    { "id": "index", "file": "demo/index.html", "title": "序 · 行业大棋盘",
      "screens": [ { "id": "s1-cover", "title": "封面钩子" },
                   { "id": "s2-chessboard", "title": "供需连·三道墙" } ] }
  ]
}
```

## 页内嵌 `deck-config`（运行时快照，每页必带）

```html
<script type="application/json" class="deck-config">
{ "case": "job-agent",
  "page": { "id": "sop", "title": "01 · 卷疯了的行业" },
  "prev": "index.html",
  "next": "agent.html",
  "chapters": [ { "id": "index", "file": "index.html", "title": "序" },
                { "id": "sop", "file": "sop.html", "title": "01 卡点" } ] }
</script>
```
- `chapters` 全量列出本案例所有章（供顶栏 tab 与 →/← 翻章）；`prev`/`next` 为相邻章文件。
- 一致性：`manifest.json` 权威，`deck-config` 是快照，改动需两者同步。
