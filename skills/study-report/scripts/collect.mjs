/**
 * collect.mjs — 48h 多工具采集扫描 → 采集清单.json
 *
 * 产出「采集清单」（每条：来源工具 / 时间 / 类型[会话|文件|交付物] / 摘要 / 产出物路径 / URL）
 * 先给用户看采集到什么，缺哪类工具提示用户确认路径。
 *
 * 纪律：所有工具路径「探测存在才扫」，未知工具列「待确认」不阻塞；
 *       不伪造任何采集结果——扫不到就报 0 并注明原因。
 *
 * 用法：node collect.mjs [--hours 48] [--out <path>] [--max-per-tool 200]
 * 输出：采集清单 JSON（stdout 或 --out 文件）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ── 工具路径探测表（存在才扫）──────────────────────────────── */
const HOME = os.homedir();
const ALT_HOME = '/opt/data/home'; // 容器常见：getpwuid home ≠ $HOME

function candidatePaths(rel) {
  const set = new Set();
  for (const base of [HOME, ALT_HOME, '/root']) {
    if (base) set.add(path.join(base, rel));
  }
  if (process.env.STUDY_REPORT_EXTRA_SCAN_ROOT) set.add(path.join(process.env.STUDY_REPORT_EXTRA_SCAN_ROOT, rel));
  return [...set];
}

const TOOL_PROBES = [
  {
    tool: 'Claude Code',
    kind: 'session',
    paths: candidatePaths('.claude/projects'), // <proj>/*.jsonl
    scan: scanClaudeCode,
  },
  {
    tool: 'Codex',
    kind: 'session',
    paths: [...candidatePaths('.codex/sessions'), ...candidatePaths('.codex/log')],
    scan: scanGenericJsonlDir,
  },
  {
    tool: 'WorkBuddy',
    kind: 'session',
    paths: [...candidatePaths('Library/Application Support/WorkBuddy'), ...candidatePaths('.workbuddy')],
    scan: scanGenericJsonlDir,
  },
  {
    tool: 'Trae',
    kind: 'session',
    paths: [...candidatePaths('.trae/sessions'), ...candidatePaths('.trae')],
    scan: scanGenericJsonlDir,
  },
  {
    tool: 'OpenClaw',
    kind: 'session',
    paths: [...candidatePaths('.openclaw/sessions'), ...candidatePaths('.openclaw')],
    scan: scanGenericJsonlDir,
  },
  {
    tool: '元宝',
    kind: 'session',
    paths: [...candidatePaths('.yuanbao'), ...candidatePaths('Library/Application Support/yuanbao')],
    scan: scanGenericJsonlDir,
  },
  {
    tool: 'Hermes Agent',
    kind: 'session',
    paths: [...candidatePaths('.fmode-harness-agent'), ...candidatePaths('.fmode-harness')],
    scan: scanHermes,
  },
];

/* ── 工作区产出物目录 ───────────────────────────────────────── */
const WORKSPACE_DIRS = ['projects', 'git-repos', 'Desktop', 'Documents'];
const WORKSPACE_EXTS = new Set(['.md', '.html', '.pdf', '.docx', '.xlsx', '.pptx']);
const WORKSPACE_SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.venv', 'venv', '__pycache__']);

/* ── 各工具扫描实现 ─────────────────────────────────────────── */

function* walk(dir, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!WORKSPACE_SKIP.has(e.name)) yield* walk(p, depth + 1, maxDepth);
    } else if (e.isFile()) {
      yield p;
    }
  }
}

function withinHours(mtimeMs, hours, now) {
  const ageH = (now - mtimeMs) / 3600000;
  return ageH >= 0 && ageH <= hours;
}

/** Claude Code：读 <projects>/<proj> 目录下的 .jsonl 会话（提取 user 消息 / 工具结果 / 产出文件路径） */
function scanClaudeCode(dirs, cutoff, now, maxPerTool) {
  const items = [];
  for (const root of dirs) {
    let projDirs;
    try { projDirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { continue; }
    for (const proj of projDirs) {
      const projPath = path.join(root, proj.name);
      let files;
      try { files = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const fp = path.join(projPath, f);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        if (!withinHours(st.mtimeMs, (now - cutoff) / 3600000, now)) continue;
        const sess = summarizeClaudeSession(fp, st, proj.name);
        if (sess) items.push(sess);
      }
    }
  }
  return items.sort((a, b) => b.time.localeCompare(a.time)).slice(0, maxPerTool);
}

function summarizeClaudeSession(fp, st, projDir) {
  let userMsgs = 0;
  let asstMsgs = 0;
  let toolUses = 0;
  let firstUser = null;
  const producedFiles = new Set();
  let cwd = null;
  let startedAt = null;
  try {
    const lines = fs.readFileSync(fp, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.timestamp && !startedAt) startedAt = d.timestamp;
      if (d.cwd) cwd = d.cwd;
      if (d.type === 'user' && d.message) {
        const c = d.message.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '';
        if (text && !text.startsWith('<') && !/system-reminder|tool_result/i.test(text.slice(0, 60))) {
          userMsgs++;
          if (!firstUser && text.trim().length > 12) firstUser = text.trim().slice(0, 90);
        }
      } else if (d.type === 'assistant' && d.message) {
        asstMsgs++;
        const c = d.message.content;
        if (Array.isArray(c)) {
          for (const x of c) {
            if (x.type === 'tool_use') {
              toolUses++;
              const inp = x.input || {};
              const fp2 = inp.file_path || inp.notebook_path;
              if (fp2 && /\.(md|html|pdf|docx|xlsx|pptx|mjs|js|py|json)$/i.test(fp2)) producedFiles.add(fp2);
              if (x.name === 'Bash' && typeof inp.command === 'string') {
                const m = inp.command.match(/([\w./-]+\.(?:html|md|pdf))\b/g);
                if (m) m.forEach(f => { if (!/node_modules/.test(f)) producedFiles.add(f); });
              }
            }
          }
        }
      }
    }
  } catch { return null; }
  if (!firstUser) firstUser = '(会话无可读用户消息)';
  return {
    source: 'Claude Code',
    time: (startedAt || st.mtime.toISOString()),
    type: '会话',
    summary: `用户消息 ${userMsgs} 条 / 助手 ${asstMsgs} 条 / 工具调用 ${toolUses} 次 — ${firstUser}`,
    artifacts: [...producedFiles].slice(0, 12),
    path: fp,
    project: cwd || projDir.replace(/^-/, '/'),
    url: null,
  };
}

/** 通用 jsonl/json 会话目录扫描（Codex/Trae/WorkBuddy/OpenClaw/元宝） */
function scanGenericJsonlDir(dirs, cutoff, now, maxPerTool) {
  const items = [];
  for (const root of dirs) {
    for (const fp of walk(root, 0, 3)) {
      const ext = path.extname(fp);
      if (!['.jsonl', '.json', '.log'].includes(ext)) continue;
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (!withinHours(st.mtimeMs, (now - cutoff) / 3600000, now)) continue;
      if (st.size > 5 * 1024 * 1024) continue; // >5MB 只登记不深读
      let summary = `${path.basename(fp)}（${(st.size / 1024).toFixed(0)}KB）`;
      try {
        const head = fs.readFileSync(fp, 'utf-8').slice(0, 4096);
        const m = head.match(/"(?:text|content|message|prompt|instruction)"\s*:\s*"([^"]{16,90})/);
        if (m) summary = m[1].replace(/\\n/g, ' ');
      } catch { /* keep default */ }
      items.push({
        source: null, // 由调用方填
        time: st.mtime.toISOString(),
        type: '会话',
        summary,
        artifacts: [],
        path: fp,
        project: null,
        url: null,
      });
    }
  }
  return items.slice(0, maxPerTool);
}

/** Hermes Agent：snapshots + tmp 产物 */
function scanHermes(dirs, cutoff, now, maxPerTool) {
  const items = [];
  const interesting = ['sessions-recent.md', 'agent-log.json', 'skills-index.txt', 'container-topology.md'];
  for (const root of dirs) {
    for (const fp of walk(root, 0, 4)) {
      const st = (() => { try { return fs.statSync(fp); } catch { return null; } })();
      if (!st || !withinHours(st.mtimeMs, (now - cutoff) / 3600000, now)) continue;
      const name = path.basename(fp);
      let type = '文件';
      let summary = `${name}（${(st.size / 1024).toFixed(0)}KB）`;
      if (name === 'agent-log.json') {
        type = '会话';
        try {
          const log = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          const arr = Array.isArray(log) ? log : Object.values(log);
          const last = arr[arr.length - 1];
          summary = `agent 心跳日志 ${arr.length} 条，最近：${last && last.agent ? last.agent + ' @ ' + (last.timestamp || '') : '(空)'}`;
        } catch { /* keep */ }
      } else if (name === 'sessions-recent.md') {
        type = '会话';
        try {
          const head = fs.readFileSync(fp, 'utf-8').slice(0, 600);
          const m = head.match(/导出时间:\s*(\S+)/);
          summary = `最近会话快照${m ? `（导出 ${m[1]}）` : ''}`;
        } catch { /* keep */ }
      } else if (/\.md$/.test(name)) {
        try {
          const head = fs.readFileSync(fp, 'utf-8').slice(0, 400);
          const t = head.match(/^#\s+(.+)$/m);
          if (t) summary = t[1].slice(0, 90);
        } catch { /* keep */ }
      }
      items.push({ source: 'Hermes Agent', time: st.mtime.toISOString(), type, summary, artifacts: [], path: fp, project: null, url: null });
    }
  }
  return items.sort((a, b) => b.time.localeCompare(a.time)).slice(0, maxPerTool);
}

/** 工作区：48h 内 mtime 新文件（.md/.html/.pdf/.docx/.xlsx） */
function scanWorkspaces(hours, now, maxPerTool) {
  const items = [];
  const roots = [...new Set([...WORKSPACE_DIRS.map(d => path.join(HOME, d)), ...WORKSPACE_DIRS.map(d => path.join(ALT_HOME, d)), '/opt/data/git-repos', '/opt/data/projects'])];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const fp of walk(root, 0, 5)) {
      const ext = path.extname(fp).toLowerCase();
      if (!WORKSPACE_EXTS.has(ext)) continue;
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (!withinHours(st.mtimeMs, hours, now)) continue;
      let summary = `${path.basename(fp)}（${(st.size / 1024).toFixed(0)}KB）`;
      if (ext === '.md') {
        try {
          const head = fs.readFileSync(fp, 'utf-8').slice(0, 500);
          const t = head.match(/^#\s+(.+)$/m);
          if (t) summary = t[1].slice(0, 90);
        } catch { /* keep */ }
      }
      items.push({
        source: '工作区',
        time: st.mtime.toISOString(),
        type: ext === '.html' ? '交付物' : '文件',
        summary,
        artifacts: [fp],
        path: fp,
        project: path.basename(path.dirname(fp)),
        url: null,
      });
    }
  }
  return items.sort((a, b) => b.time.localeCompare(a.time)).slice(0, maxPerTool);
}

/* ── 汇总 ───────────────────────────────────────────────────── */
export function collect({ hours = 48, maxPerTool = 200 } = {}) {
  const now = Date.now();
  const cutoff = now - hours * 3600000;
  const items = [];
  const toolsStatus = [];

  for (const probe of TOOL_PROBES) {
    const existing = probe.paths.filter(p => fs.existsSync(p));
    if (existing.length === 0) {
      toolsStatus.push({ tool: probe.tool, status: '未检出（本机无该工具痕迹，跳过；若实际有用请人工确认路径）' });
      continue;
    }
    const found = probe.scan(existing, cutoff, now, maxPerTool);
    for (const it of found) if (!it.source) it.source = probe.tool;
    items.push(...found);
    toolsStatus.push({ tool: probe.tool, status: `已扫描 ${existing.length} 个路径，命中 ${found.length} 条` });
  }

  const ws = scanWorkspaces(hours, now, maxPerTool);
  items.push(...ws);
  toolsStatus.push({ tool: '工作区产出物', status: `已扫描工作区目录，命中 ${ws.length} 条` });

  // 统计
  const bySource = {};
  const byType = {};
  for (const it of items) {
    bySource[it.source] = (bySource[it.source] || 0) + 1;
    byType[it.type] = (byType[it.type] || 0) + 1;
  }
  const artifactPaths = [...new Set(items.flatMap(i => i.artifacts || []))].slice(0, 300);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      windowHours: hours,
      windowStart: new Date(cutoff).toISOString(),
      host: os.hostname(),
      user: process.env.USER || os.userInfo().username,
    },
    stats: {
      total: items.length,
      sessionCount: byType['会话'] || 0,
      fileCount: (byType['文件'] || 0) + (byType['交付物'] || 0),
      bySource,
      byType,
      artifactCount: artifactPaths.length,
    },
    toolsStatus,
    items,
    artifacts: artifactPaths,
  };
}

/* ── CLI ────────────────────────────────────────────────────── */
function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isMain) {
  const hours = Number(argVal('--hours', '48'));
  const out = argVal('--out', null);
  const result = collect({ hours, maxPerTool: Number(argVal('--max-per-tool', '200')) });

  /* 人类可读采集清单 */
  console.log(`\n📋 采集清单（近 ${hours}h · 生成于 ${result.meta.generatedAt}）`);
  console.log(`   会话 ${result.stats.sessionCount} 条 · 文件/交付物 ${result.stats.fileCount} 条 · 合计 ${result.stats.total} 条\n`);
  console.log('工具探测：');
  for (const t of result.toolsStatus) console.log(`  · ${t.tool}: ${t.status}`);
  console.log('\n来源分布：', JSON.stringify(result.stats.bySource));
  console.log('\n最近条目（前 20）：');
  for (const it of result.items.slice(0, 20)) {
    console.log(`  [${it.source}] ${it.time.slice(0, 16).replace('T', ' ')} ${it.type} — ${it.summary.slice(0, 70)}`);
  }
  if (result.stats.total === 0) {
    console.log('\n⚠️  未采集到任何痕迹：确认工具安装路径，或用 --hours 放宽窗口。不伪造采集结果。');
  }
  console.log('');

  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), JSON.stringify(result, null, 2));
    console.log(`已写出：${path.resolve(out)}`);
  } else {
    process.stdout.write('\n<!--JSON-BEGIN-->\n' + JSON.stringify(result) + '\n<!--JSON-END-->\n');
  }
}
