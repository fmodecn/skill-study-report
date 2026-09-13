/**
 * ask.mjs — 三问追问交互（一次呈现三问，支持连答）
 *
 * 采集完成后固定三问（过去/现在/未来）一次全部呈现，用户可一次性连答（推荐，省时）；
 * 也兼容逐问回答（每答以「---」分隔）或分次补充；
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

/** 连答解析：把一次输入按分隔符拆成三问答案
 *  支持三种格式：
 *  A) 一次粘贴三段，以行「---」分隔 → 依序对应过去/现在/未来
 *  B) JSON 对象 {"past":"...","present":"...","future":"..."}
 *  C) 空输入 → 全部跳过
 */
export function parseBatchAnswer(raw) {
  const out = { past: '', present: '', future: '' };
  if (!raw || !raw.trim()) return out;
  const s = raw.trim();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      for (const q of QUESTIONS) out[q.key] = String(j[q.key] || '').trim();
      return out;
    } catch { /* 非 JSON, 走分隔符 */ }
  }
  const parts = s.split(/^---+$/m).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 3) {
    out.past = parts[0]; out.present = parts[1]; out.future = parts.slice(2).join('\n');
  } else {
    // 无分隔符: 单段输入 → 记入"现在"(最常见的单次表达), 其余标待补充
    out.present = s;
  }
  return out;
}

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
    // 连答模式：一次呈现三问，用户可一次性回答（推荐）
    console.log(`\n${'═'.repeat(60)}`);
    console.log('【复盘三问】可以一次性连答（推荐）——三段答案之间用一行 --- 分隔；');
    console.log('  也可以直接回车进入逐问模式；输入 JSON {"past":"…","present":"…","future":"…"} 亦可。');
    for (const q of QUESTIONS) {
      console.log(`\n【${q.tag}】${q.text}`);
      console.log(`  （示例：${q.placeholder}）`);
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log('请粘贴你的回答（三段用 --- 分隔，或 JSON；直接回车=逐问模式）：');
    process.stdout.write('> ');
    const raw = await nextLine(Math.max(timeoutMs, 180000));
    const batch = parseBatchAnswer(raw || '');
    const gotAny = batch.past || batch.present || batch.future;
    if (gotAny) {
      Object.assign(answers, batch);
      for (const q of QUESTIONS) {
        if (answers[q.key]) console.log(`  ✓ ${q.tag}：已记录 ${answers[q.key].length} 字`);
      }
    }
    // 逐问补漏：连答缺失的问项再单独问一轮（每问一次机会）
    for (const q of QUESTIONS) {
      if (answers[q.key]) continue;
      console.log(`\n【${q.tag}】${q.text}`);
      console.log(`  （示例：${q.placeholder}）（直接回车跳过）`);
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
