/**
 * build-report.mjs — HTML PPT 生成（lib 复制 + 数据注入）
 *
 * 读采集清单.json + 追问回答.json → 注入 report-template.html（skill-present 标准）→
 * 输出独立报告目录（report.html + 全套 lib 复制 + report-data.json）。
 *
 * 规则（borrow skill-present 报告策略）：数据优先 / 证据链 / 来源标注 / 数字动画。
 * 缺数据段优雅降级：三问未答 → 标注【待补充：用户口述】；交付物无 URL → 虚线占位卡。
 *
 * 用法：node build-report.mjs --collect collect.json [--answers answers.json] \
 *         [--name 姓名] [--enterprise 企业] [--out 输出目录]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  try { return iso.slice(0, 10); } catch { return iso; }
}

/** lib 全套独立复制（每个文件独立复制确保可用——v2.4.1 base.css 缺失教训） */
function copyLib(outDir) {
  const srcLib = path.join(SKILL_DIR, 'lib');
  const dstLib = path.join(outDir, 'lib');
  const REQUIRED = [
    'theme/tokens.css', 'theme/base.css', 'theme/theme.js',
    'player/deck.js', 'player/canvas-scale.js',
    'components/chat-window.css', 'components/chat-window.js',
    'components/group-chat.css', 'components/group-chat.js',
    'components/logic-flow.css', 'components/logic-flow.js',
    'vendor/gsap/gsap.min.js',
  ];
  const copied = [];
  fs.mkdirSync(dstLib, { recursive: true });
  for (const rel of REQUIRED) {
    const src = path.join(srcLib, rel);
    const dst = path.join(dstLib, rel);
    if (!fs.existsSync(src)) throw new Error(`lib 缺失（安装不完整）：${rel} —— 重新克隆本仓库`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied.push(rel);
  }
  return copied;
}

/* ── 各段渲染 ─────────────────────────────────────────────── */

function renderDistRows(bySource) {
  const entries = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(e => e[1]));
  return entries.map(([name, n]) => {
    const w = Math.max(2, Math.round((n / max) * 560));
    return `<div class="dist-row"><div class="dist-name">${esc(name)}</div><div class="dist-bar" style="width:${w}px;"></div><div class="dist-num">${n}</div></div>`;
  }).join('\n        ');
}

/** 交付物墙：优先在线 URL（可 iframe 嵌套），本地文件给占位卡 */
function renderWall(items) {
  const candidates = items
    .filter(i => i.type === '交付物' || /\.(html)$/i.test(i.path || ''))
    .slice(0, 6);
  if (candidates.length === 0) {
    return `<div class="w-card"><div class="w-nolink">本窗口未检出 HTML 交付物<br>（采集窗口内无 .html 产出）</div><div class="w-title">交付物墙占位</div><div class="w-src">缺数据段 · 优雅降级</div></div>`;
  }
  return candidates.map(i => {
    const online = /^https?:\/\//.test(i.url || '');
    if (online) {
      const iframeOk = i.url.includes('fmode.cn') || i.url.includes('obs.') || i.url.includes('s3.') || i.iframable === true;
      return `<div class="w-card">
          ${iframeOk ? `<iframe src="${esc(i.url)}" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>` : `<div class="w-nolink">外域页面禁止 iframe 嵌套<br>点击标题新窗打开</div>`}
          <div class="w-title"><a href="${esc(i.url)}" target="_blank" rel="noopener" style="color:var(--brand-1); text-decoration:none;">${esc(i.summary.slice(0, 40))}</a></div>
          <div class="w-src">${esc(i.source)} · ${fmtDate(i.time)}</div>
          ${iframeOk ? '<div class="w-note">✓ 在线项目 · 可 iframe 嵌套展示</div>' : '<div class="w-src">仅链接 · 不强行嵌套</div>'}
        </div>`;
    }
    return `<div class="w-card">
        <div class="w-nolink">本地文件<br>${esc(path.basename(i.path || ''))}</div>
        <div class="w-title">${esc(i.summary.slice(0, 44))}</div>
        <div class="w-src">${esc(i.source)} · ${fmtDate(i.time)} · 本地路径已入附录</div>
      </div>`;
  }).join('\n        ');
}

function renderTimeline(items, n = 7) {
  const picks = items.slice(0, n);
  if (picks.length === 0) return `<div class="tl-item"><div class="tl-time">—</div><div class="tl-text">采集窗口内无会话/文件记录</div></div>`;
  return picks.map(i => `<div class="tl-item">
        <div class="tl-time">${esc(i.time.slice(5, 16).replace('T', ' '))} · ${esc(i.source)} · ${esc(i.type)}</div>
        <div class="tl-text">${esc(i.summary.slice(0, 84))}</div>
      </div>`).join('\n      ');
}

function renderQBlock(answer, pending, links, pendingBadgeHtml) {
  const body = answer
    ? `<div class="q-a">${esc(answer)}</div>`
    : `<div class="q-a" style="color:var(--text-4);">（本轮未采集到口述内容）</div>`;
  const ev = (links || []).map(l =>
    `<div class="ev">↳ 证据 [${esc(l.source)} ${fmtDate(l.time)}] ${esc(l.evidence)}</div>`).join('\n          ');
  return body + pendingBadgeHtml + (ev ? `\n        <div class="q-ev">\n          ${ev}\n        </div>` : '');
}

function renderAppendix(items, n = 14) {
  const rows = items.slice(0, n).map(i => `<tr>
          <td class="mono">${esc(i.time.slice(5, 16).replace('T', ' '))}</td>
          <td>${esc(i.source)}</td>
          <td>${esc(i.summary.slice(0, 80))}</td>
          <td class="mono">${esc(i.url || i.path || '—')}</td>
        </tr>`).join('\n        ');
  return rows || `<tr><td colspan="4" style="color:var(--text-4);">无采集记录</td></tr>`;
}

/* ── 主流程 ─────────────────────────────────────────────── */

export function buildReport({ collect, answers, name = '学员', enterprise = '企业 AI 落地研修', outDir = null }) {
  const tplPath = path.join(SKILL_DIR, 'templates', 'report-template.html');
  if (!fs.existsSync(tplPath)) throw new Error('模板缺失：templates/report-template.html');
  const tpl = fs.readFileSync(tplPath, 'utf-8');

  const stats = collect.stats || {};
  const dateRange = `${fmtDate(collect.meta.windowStart)} ~ ${fmtDate(collect.meta.generatedAt)}`;
  const toolList = Object.keys(stats.bySource || {}).join(' / ') || '—';
  const messages = collect.items.reduce((s, i) => {
    const m = i.summary.match(/用户消息 (\d+) 条 \/ 助手 (\d+) 条/);
    return s + (m ? Number(m[1]) + Number(m[2]) : 0);
  }, 0);

  const ans = (answers && answers.answers) || {};
  const links = (answers && answers.evidenceLinks) || {};

  /* 无 answers 文件 = 全部三问视为待补充；有文件时按 pending 标记 */
  const noAnswersAtAll = !answers;
  const pendingBadge = k => (noAnswersAtAll || ans[k + '_pending'])
    ? `<div style="margin-top:8px;"><span class="pending-badge">【待补充：用户口述】</span></div>`
    : '';
  const qHtml = key => renderQBlock(ans[key] || '', ans[key + '_pending'], links[key], pendingBadge(key));

  const html = tpl
    .replace(/\{\{REPORT_TITLE\}\}/g, esc(`${name} · 学习复盘报告`))
    .replace(/\{\{NAME\}\}/g, esc(name))
    .replace(/\{\{ENTERPRISE\}\}/g, esc(enterprise))
    .replace(/\{\{DATE_RANGE\}\}/g, esc(dateRange))
    .replace(/\{\{SESSIONS\}\}/g, String(stats.sessionCount ?? 0))
    .replace(/\{\{TOOLKINDS\}\}/g, String(Object.keys(stats.bySource || {}).length))
    .replace(/\{\{ARTIFACTS\}\}/g, String(stats.artifactCount ?? 0))
    .replace(/\{\{MESSAGES\}\}/g, String(messages))
    .replace(/\{\{HOURS\}\}/g, String(collect.meta.windowHours ?? 48))
    .replace(/\{\{WINDOW\}\}/g, esc(dateRange))
    .replace(/\{\{TOOL_LIST\}\}/g, esc(toolList))
    .replace(/\{\{TOOL_DIST_ROWS\}\}/g, renderDistRows(stats.bySource || {}))
    .replace(/\{\{ARTIFACT_WALL\}\}/g, renderWall(collect.items || []))
    .replace(/\{\{TIMELINE\}\}/g, renderTimeline(collect.items || []))
    .replace(/\{\{ANSWER_PAST\}\}/g, '')
    .replace(/\{\{ANSWER_PRESENT\}\}/g, '')
    .replace(/\{\{ANSWER_FUTURE\}\}/g, '')
    .replace(/\{\{EVIDENCE_PAST\}\}/g, '')
    .replace(/\{\{EVIDENCE_PRESENT\}\}/g, '')
    .replace(/\{\{EVIDENCE_FUTURE\}\}/g, '')
    .replace(/\{\{PAST_PENDING\}\}/g, '')
    .replace(/\{\{PRESENT_PENDING\}\}/g, '')
    .replace(/\{\{FUTURE_PENDING\}\}/g, '')
    .replace(/\{\{APPENDIX_ROWS\}\}/g, renderAppendix(collect.items || []))
    .replace(/\{\{TOTAL\}\}/g, String(stats.total ?? 0))
    .replace(/\{\{APPENDIX_N\}\}/g, String(Math.min(14, stats.total ?? 0)));

  /* 三问块在模板中带占位符嵌套，这里二次注入（避免 regex 嵌套转义地狱） */
  const inject = (screenId, inner, source) => {
    const re = new RegExp(`(<section class="screen" id="${screenId}">[\\s\\S]*?<div class="q-h">[\\s\\S]*?</div>\\n)([\\s\\S]*?)(\\n      </div>\\n    </div>)`);
    return (source || html).replace(re, (m, head, _body, tail) => head + inner + tail);
  };
  let finalHtml = html;
  finalHtml = inject.call(null, 'p5', qHtml('past').trim(), finalHtml);
  finalHtml = inject.call(null, 'p6', qHtml('present').trim(), finalHtml);
  finalHtml = inject.call(null, 'p7', qHtml('future').trim(), finalHtml);

  /* 输出目录：report.html + lib 全套 + report-data.json */
  const dir = outDir || path.join(process.cwd(), 'study-report-out');
  fs.mkdirSync(dir, { recursive: true });
  const copied = copyLib(dir);
  fs.writeFileSync(path.join(dir, 'report.html'), finalHtml);
  fs.writeFileSync(path.join(dir, 'report-data.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    name, enterprise, dateRange,
    collect: { meta: collect.meta, stats: collect.stats, toolsStatus: collect.toolsStatus, items: collect.items, artifacts: collect.artifacts },
    answers: answers || null,
    libCopied: copied,
  }, null, 2));

  return {
    dir,
    reportPath: path.join(dir, 'report.html'),
    dataPath: path.join(dir, 'report-data.json'),
    pages: 9,
    stats,
  };
}

/* ── CLI ─────────────────────────────────────────────── */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isMain) {
  const collectFile = argVal('--collect', null);
  const answersFile = argVal('--answers', null);
  if (!collectFile || !fs.existsSync(collectFile)) {
    console.error('[build-report] 缺 --collect <采集清单.json>（先跑 collect.mjs --out）');
    process.exit(2);
  }
  const collect = JSON.parse(fs.readFileSync(collectFile, 'utf-8'));
  let answers = null;
  if (answersFile && fs.existsSync(answersFile)) {
    answers = JSON.parse(fs.readFileSync(answersFile, 'utf-8'));
  } else {
    console.log('[build-report] 未提供 --answers：三问标注【待补充：用户口述】，用采集数据先行出报告。');
  }
  const r = buildReport({
    collect,
    answers,
    name: argVal('--name', '学员'),
    enterprise: argVal('--enterprise', '企业 AI 落地研修'),
    outDir: argVal('--out', null),
  });
  console.log(`\n✅ 报告已生成：${r.reportPath}`);
  console.log(`   页数：${r.pages} · 会话 ${r.stats.sessionCount ?? 0} · 产出物 ${r.stats.artifactCount ?? 0}`);
  console.log(`   lib 已复制 ${path.basename(r.dir)}/lib/（base.css 教训：逐文件校验复制）`);
  console.log(`   本地预览：file://${pathToFileURL(r.reportPath).href.replace('file://', '')}`);
}
