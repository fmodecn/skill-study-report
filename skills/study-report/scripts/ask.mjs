/**
 * ask.mjs — 三问追问交互（逐问等待用户）
 *
 * 采集完成后固定三轮问题（过去/现在/未来），逐问在终端等待用户输入；
 * 用户口述与采集素材做「关联标记」（口述里提到的项目名 ↔ 采集条目证据）。
 * 用户不答（直接回车 / 超时 / --non-interactive）→ 该问记空值并标注【待补充：用户口述】，
 * 上游用采集数据先行出报告——不阻塞、不编造用户感受。
 *
 * 用法：node ask.mjs --collect collect.json [--answers answers.json] [--timeout 120] [--non-interactive]
 */

import fs from 'node:fs';
import path from 'node:path';

const QUESTIONS = [
  {
    key: 'past',
    tag: '第一问 · 过去',
    text: '您觉得企业之前 AI 落地不够原生、不够性感的地方是什么？过去的痛点或疑惑？（直接回车可跳过）',
    placeholder: '如：工具是有了，但都要一个个单独打开用，和业务流程是两张皮……',
  },
  {
    key: 'present',
    tag: '第二问 · 现在',
    text: '这两天具体感受与收获？（成果本身已从采集拿到，只问感受 + 哪个具体项目让您有感觉——说到项目名我会自动关联采集证据）',
    placeholder: '如：两天装了 8 个技能；最有感觉的是 xx 报告那次，一句话就出来了……',
  },
  {
    key: 'future',
    tag: '第三问 · 未来',
    text: '学到的这些细节之后，想回企业落地或探索的方向？畅想未来（直接回车可跳过）',
    placeholder: '如：想把这套技能包装成培训课，让每个业务部门都装上……',
  },
];

/** 口述 → 采集素材关联标记：问题里提到的项目/文件关键词 ↔ 采集条目 */
export function linkAnswersToEvidence(answers, collectResult) {
  const links = {};
  if (!collectResult || !Array.isArray(collectResult.items)) return links;
  const pool = collectResult.items;
  for (const q of QUESTIONS) {
    const text = answers[q.key];
    links[q.key] = [];
    if (!text) continue;
    const seen = new Set();
    // 提取口述中的候选关键词：≥2 个汉字的连续片段 + 采集条目摘要中的关键 token
    const grams = new Set();
    for (const m of text.match(/[一-龥A-Za-z0-9_-]{2,}/g) || []) {
      for (let i = 0; i < m.length - 1; i++) {
        for (const len of [6, 5, 4, 3, 2]) {
          if (i + len <= m.length) grams.add(m.slice(i, i + len));
        }
      }
    }
    for (const it of pool) {
      const hay = `${it.summary} ${it.project || ''} ${path.basename(it.path || '')}`;
      for (const g of grams) {
        if (hay.includes(g) && !seen.has(it.path)) {
          seen.add(it.path);
          links[q.key].push({ evidence: it.summary.slice(0, 80), source: it.source, path: it.path, time: it.time, matched: g });
          break;
        }
      }
      if (links[q.key].length >= 5) break;
    }
  }
  return links;
}

/** 自管理行读取：TTY 逐行等待；管道场景把缓冲中剩余的行依次消费（每问一行），EOF/超时给空答案 */
function makeLineReader() {
  const isTTY = process.stdin.isTTY;
  const queue = [];
  let eof = false;
  let buf = '';
  let notify = null;
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      queue.push(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
    if (notify) { const n = notify; notify = null; n(); }
  });
  process.stdin.on('end', () => { eof = true; if (notify) { const n = notify; notify = null; n(); } });
  process.stdin.on('error', () => { eof = true; if (notify) { const n = notify; notify = null; n(); } });
  if (!isTTY) process.stdin.resume();
  return function nextLine(timeoutMs) {
    return new Promise(resolve => {
      if (queue.length > 0) return resolve(queue.shift());
      if (eof) return resolve('');
      let timer = null;
      const finish = val => {
        if (timer) clearTimeout(timer);
        notify = null;
        resolve(val);
      };
      if (timeoutMs > 0) timer = setTimeout(() => finish(''), timeoutMs);
      notify = () => {
        if (queue.length > 0) finish(queue.shift());
        else if (eof) finish(buf || '');
        /* 否则等下一块 data */
      };
    });
  };
}

export async function runAsk({ collectFile = null, answersFile = null, timeoutMs = 120000, nonInteractive = false } = {}) {
  let collectResult = null;
  if (collectFile) {
    try { collectResult = JSON.parse(fs.readFileSync(collectFile, 'utf-8')); } catch { collectResult = null; }
  }

  const answers = {};
  if (nonInteractive) {
    for (const q of QUESTIONS) answers[q.key] = '';
    console.log('[ask] 非交互模式：三轮问题全部标注【待补充：用户口述】，报告先行用采集数据生成。');
  } else {
    const nextLine = makeLineReader();
    for (const q of QUESTIONS) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`【${q.tag}】${q.text}`);
      console.log(`  （示例：${q.placeholder}）`);
      process.stdout.write('> ');
      const line = await nextLine(timeoutMs);
      answers[q.key] = (line || '').trim();
      if (!answers[q.key]) console.log('  （已跳过 → 报告将标注【待补充：用户口述】）');
    }
  }

  for (const q of QUESTIONS) {
    if (!answers[q.key]) answers[q.key + '_pending'] = true;
  }

  const links = linkAnswersToEvidence(answers, collectResult);
  const result = { answeredAt: new Date().toISOString(), answers, evidenceLinks: links };

  if (answersFile) {
    fs.mkdirSync(path.dirname(path.resolve(answersFile)), { recursive: true });
    fs.writeFileSync(path.resolve(answersFile), JSON.stringify(result, null, 2));
    console.log(`\n已写出：${path.resolve(answersFile)}`);
  } else {
    console.log('\n<!--ANSWERS-BEGIN-->\n' + JSON.stringify(result, null, 2) + '\n<!--ANSWERS-END-->');
  }
  return result;
}

/* ── CLI ────────────────────────────────────────────────────── */
function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isMain) {
  runAsk({
    collectFile: argVal('--collect', null),
    answersFile: argVal('--answers', null),
    timeoutMs: Number(argVal('--timeout', '120000')),
    nonInteractive: process.argv.includes('--non-interactive'),
  }).catch(e => {
    console.error('[ask] 异常退出：', e.message);
    process.exit(2);
  });
}
