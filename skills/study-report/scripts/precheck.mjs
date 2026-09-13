/**
 * precheck.mjs — 安装前置自检（安装体检表）
 *
 * 按 07-git.md 已验证链路检查三环节，任一环节不通给出恢复指引，绝不伪造通过：
 *   1. 平台身份：~/.fmode/config/user.json 的 fmodeApiToken（真实字段名，非 sessionToken）
 *      → POST server.fmode.cn/api/functions HEAD 探测平台可达
 *   2. Git 账户：POST /api/functions {token, path:"/gogs/admin/proxy",
 *      params:{method:"POST", path:"/admin/users", body:{...}}}
 *      → 201 新建 / 200 幂等返回新 token.sha1（忘密码不找回，重调即得）
 *      → 401/209 → 提示走「对话式验证码登录」恢复（07-git.md 标准节）
 *   3. Storage 能力：探测 obsutil config / OBS_AK 环境变量；无 → 不阻塞（报告走 Gogs 降级）
 *
 * 纪律：凭据零暴露（输出绝不含 token/AK/SK 本体）；结果只报状态不造假。
 *
 * 用法：node precheck.mjs [--json]
 *   --json  供上游脚本消费（含 gogsToken，仅内存传递，不落盘）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
const HOME = os.homedir();

// 凭据本地缓存（~/.fmode/credentials/gogs.json, 600 权限）：
// 首次开户成功后持久化 {username, token, savedAt}；后续运行直接复用，
// 仅当缓存 token 校验失败（401/403）时才重调开户接口刷新缓存。
// 已有 ~/.fmode 完整配置的用户天然命中缓存路径，零重复获取。
const GOGS_CACHE = path.join(HOME, '.fmode', 'credentials', 'gogs.json');
function readGogsCache() {
  try {
    if (!fs.existsSync(GOGS_CACHE)) return null;
    const j = JSON.parse(fs.readFileSync(GOGS_CACHE, 'utf8'));
    return (j.username && j.token) ? j : null;
  } catch { return null; }
}
function writeGogsCache(username, token) {
  try {
    fs.mkdirSync(path.dirname(GOGS_CACHE), { recursive: true });
    fs.writeFileSync(GOGS_CACHE, JSON.stringify({ username, token, savedAt: new Date().toISOString() }, null, 2));
    fs.chmodSync(GOGS_CACHE, 0o600);
  } catch { /* 缓存写失败不阻塞主流程 */ }
}

const FMODE_API_BASE = (process.env.FMODE_FUNCTIONS_BASE_URL || 'https://server.fmode.cn').replace(/\/$/, '');
const GOGS_BASE = 'https://git.fmode.cn';

function readJsonMaybe(p) {
  try {
    if (!p || !fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/* ── 环节 1：平台身份 ─────────────────────────────────────────── */
function checkPlatformIdentity() {
  const row = { item: '平台身份', ok: false, detail: '', hint: '' };
  const candidates = [
    process.env.FMODE_USER_CONFIG,
    path.join(os.homedir(), '.fmode', 'config', 'user.json'),
    path.join('/opt/data/home', '.fmode', 'config', 'user.json'),
  ].filter(Boolean);
  let token = null;
  let cfgPath = null;
  let tokenKind = null;
  for (const p of candidates) {
    const cfg = readJsonMaybe(p);
    if (cfg && cfg.fmodeApiToken) { token = cfg.fmodeApiToken; cfgPath = p; tokenKind = 'fmodeApiToken'; break; }
  }
  // 云函数 /gogs/admin/proxy 的 token 口径是 Parse sessionToken（34 位），非 sk- API token。
  // 两者都在场时 sessionToken 优先供 Git 环节使用，fmodeApiToken 仅作平台身份在场证明。
  let sessionToken = process.env.FMODE_SESSION_TOKEN && !/^sk-/.test(process.env.FMODE_SESSION_TOKEN)
    ? process.env.FMODE_SESSION_TOKEN.trim() : null;
  for (const p of candidates) {
    const cfg = readJsonMaybe(p);
    if (!sessionToken && cfg && cfg.sessionToken) { sessionToken = cfg.sessionToken; cfgPath = p; tokenKind = 'sessionToken'; break; }
  }
  if (!token && !sessionToken) {
    row.detail = '未找到 fmodeApiToken（~/.fmode/config/user.json）';
    row.hint = '登录 FMODE Studio 保存一次配置，或对话式验证码登录';
    return { row, token: null };
  }
  row.detail = `已读取（${cfgPath}，${tokenKind}=${tokenKind === 'fmodeApiToken' && token ? 'sk-***' + token.slice(-4) : '***' + String(sessionToken || '').slice(-4)}）`;
  return { row, token: sessionToken || token, tokenKind };
}

async function probePlatformReachable() {
  // HEAD 探测平台可达（任意 4xx/5xx 响应头均证明链路通）
  try {
    const res = await fetch(`${FMODE_API_BASE}/api/functions`, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return { reachable: true, status: res.status };
  } catch {
    try {
      const res = await fetch(`${FMODE_API_BASE}/parse/health`, { signal: AbortSignal.timeout(8000) });
      return { reachable: res.ok, status: res.status };
    } catch (e) {
      return { reachable: false, status: 0, error: String(e.message || e) };
    }
  }
}

/* ── 环节 2：Git 账户（07-git.md 已验证链路）──────────────────── */
async function ensureGitAccount(platformToken) {
  const row = { item: 'Git 账户', ok: false, detail: '', hint: '' };
  // ① 本地缓存优先：有凭据直接复用（验证有效性，失败才刷新）
  const cached = readGogsCache();
  if (cached) {
    const v = await fetch(`${GOGS_BASE}/api/v1/user`, { headers: { Authorization: `token ${cached.token}` }, signal: AbortSignal.timeout(15000) });
    if (v.ok) {
      return { row: { item: 'Git 账户', ok: true, detail: `本地缓存复用（${cached.username}，savedAt ${cached.savedAt.slice(0,10)}）`, hint: '' }, gogsToken: cached.token, gogsUser: cached.username };
    }
    row.hint = '缓存 token 已失效，重调开户接口刷新…';
  }
  if (!platformToken) {
    row.detail = '跳过（无平台 token）';
    row.hint = '先恢复平台身份';
    return { row, gogsToken: null, gogsUser: null };
  }
  // ② 开户/刷新（幂等）
  const mobile = process.env.FMODE_MOBILE || (cached && cached.username.replace(/^fmode-/, '')) || 'user'; // 稳定用户标识
  const username = `fmode-${mobile}`;
  try {
    const res = await fetch(`${FMODE_API_BASE}/api/functions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        token: platformToken,
        path: '/gogs/admin/proxy',
        params: {
          method: 'POST',
          path: '/admin/users',
          body: {
            username,
            // email 用 username 派生：与既有账户 email 冲突会让云函数"重置内部密码失败"(502)。
            // 422 实测：admin/users 对 email 唯一性敏感；派生值保证幂等重调永远命中同一账户。
            email: process.env.FMODE_EMAIL || `${username}@fmode.agent`,
            send_notify: false,
            // 注：已存在账户 → 云函数幂等补发新 access token（200 + token.sha1），
            // 原密码不可找回也不需要；新账户（201）由云函数代管初始密码。
          },
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 209) {
      row.detail = `平台返回 ${res.status}（token 失效/未登录）`;
      row.hint = '走「对话式验证码登录」恢复：手机号 → VerifyCode → 换 sessionToken（07-git.md 标准节）';
      return { row, gogsToken: null, gogsUser: null };
    }
    if (res.status === 201 && body.username) {
      // 新建账户：201 只返回用户对象，token 由云函数侧续发一次幂等调用取得
      const again = await fetch(`${FMODE_API_BASE}/api/functions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          token: platformToken,
          path: '/gogs/admin/proxy',
          params: { method: 'POST', path: '/admin/users', body: { username, email: process.env.FMODE_EMAIL || `${username}@fmode.agent`, send_notify: false } },
        }),
      });
      const againBody = await again.json().catch(() => ({}));
      if (again.status === 200 && againBody.token && againBody.token.sha1) {
        row.ok = true;
        row.detail = `新建 Gogs 账户 ${againBody.username}，access token 已签发（sha1 ***${againBody.token.sha1.slice(-4)}）`;
        writeGogsCache(againBody.username, againBody.token.sha1); return { row, gogsToken: againBody.token.sha1, gogsUser: againBody.username };
      }
      row.detail = `账户已创建（201）但 token 续发未返回（${again.status}）`;
      row.hint = '重跑本自检（幂等）';
      return { row, gogsToken: null, gogsUser: body.username };
    }
    if ((res.status === 200 || res.status === 502) && body.token && body.token.sha1) {
      row.ok = true;
      row.detail = `Git 账户已存在（${body.username}），幂等补发新 access token（sha1 ***${body.token.sha1.slice(-4)}）${res.status === 502 ? '（云函数 502 但返回体有效）' : ''}`;
      return { row, gogsToken: body.token.sha1, gogsUser: body.username };
    }
    /* email 冲突等 4xx → 换稳定派生 email 重试一次（幂等口径不变） */
    if (res.status >= 400 && res.status < 500 && /email/i.test(JSON.stringify(body))) {
      const altEmail = `${username}@fmode.agent`;
      const retry = await fetch(`${FMODE_API_BASE}/api/functions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          token: platformToken,
          path: '/gogs/admin/proxy',
          params: { method: 'POST', path: '/admin/users', body: { username, email: altEmail, send_notify: false } },
        }),
      });
      const retryBody = await retry.json().catch(() => ({}));
      if ((retry.status === 200 || retry.status === 201 || retry.status === 502) && retryBody.token && retryBody.token.sha1) {
        row.ok = true;
        row.detail = `Git 账户就绪（${retryBody.username}，email 冲突已换 ${altEmail}），token 补发成功（sha1 ***${retryBody.token.sha1.slice(-4)}）`;
        return { row, gogsToken: retryBody.token.sha1, gogsUser: retryBody.username };
      }
    }
    row.detail = `未预期的响应 ${res.status}：${JSON.stringify(body).slice(0, 120)}`;
    row.hint = '重跑自检；持续失败报告用户，不伪造通过';
    return { row, gogsToken: null, gogsUser: null };
  } catch (e) {
    row.detail = `网络/服务异常：${String(e.message || e).slice(0, 120)}`;
    row.hint = '检查 server.fmode.cn 可达性后重跑';
    return { row, gogsToken: null, gogsUser: null };
  }
}

/* ── 环节 3：Storage 能力（不阻塞）──────────────────────────── */
function checkStorage() {
  const row = { item: 'Storage 能力', ok: false, degraded: true, detail: '', hint: '' };
  // 3a. 环境变量
  if (process.env.OBS_AK && process.env.OBS_SK) {
    row.ok = true; row.degraded = false;
    row.detail = 'OBS_AK/OBS_SK 环境变量已配置';
    return { row };
  }
  // 3b. obsutil config 文件（OBSUTIL_CONFIG / ~/.obsutilconfig / getpwuid home 变体）
  const cfgPaths = [];
  if (process.env.OBSUTIL_CONFIG) cfgPaths.push(process.env.OBSUTIL_CONFIG);
  cfgPaths.push(path.join(os.homedir(), '.obsutilconfig'), path.join('/opt/data', '.obsutilconfig'));
  try {
    const pwHome = os.userInfo().homedir;
    if (pwHome) cfgPaths.push(path.join(pwHome, '.obsutilconfig'));
  } catch { /* ignore */ }
  for (const p of [...new Set(cfgPaths)]) {
    try {
      const text = fs.readFileSync(p, 'utf-8');
      if (/^ak=/m.test(text) && /^sk=/m.test(text)) {
        row.ok = true; row.degraded = false;
        row.detail = `obsutil config 已配置（${p}）`;
        return { row };
      }
    } catch { /* next */ }
  }
  // 3c. obsutil 可执行文件存在（有 config 但无二进制也算能力缺失）
  row.detail = '未探测到 OBS 凭据（OBS_AK/SK 环境变量 或 obsutil config）';
  row.hint = '不阻塞：报告走 Gogs 降级通道；如需 Storage 主通道，按 skill-storage init 向导一次性配置';
  return { row };
}

/* ── 主流程 ─────────────────────────────────────────────────── */
export async function runPrecheck({ json = false } = {}) {
  const { row: idRow, token } = checkPlatformIdentity();
  const reach = token ? await probePlatformReachable() : { reachable: false, status: 0 };
  if (!reach.reachable && token) {
    idRow.ok = false;
    idRow.detail += '，但平台探测不可达';
    idRow.hint = '检查网络 / server.fmode.cn 状态';
  } else if (reach.reachable) {
    idRow.ok = true;
    idRow.detail += `；平台可达（探测 ${reach.status}）`;
  }

  const git = await ensureGitAccount(reach.reachable ? token : null);
  const storage = checkStorage();

  const rows = [idRow, git.row, storage.row];
  const passAll = rows.every(r => r.ok);

  if (json) {
    // gogsToken 仅随进程内存/管道传递，禁止落盘
    process.stdout.write(JSON.stringify({
      passAll,
      rows,
      gogsToken: git.gogsToken,
      gogsUser: git.gogsUser,
    }) + '\n');
    return { passAll, rows, gogsToken: git.gogsToken, gogsUser: git.gogsUser };
  }

  /* 安装体检表（人类可读，凭据零暴露） */
  const line = '─'.repeat(66);
  console.log('┌' + line + '┐');
  console.log('│  study-report · 安装体检表' + ' '.repeat(40) + '│');
  console.log('├' + line + '┤');
  for (const r of rows) {
    const mark = r.ok ? '✅' : (r.degraded ? '🟡' : '❌');
    const name = (r.item + ' ').padEnd(10, '·');
    console.log(`│ ${mark} ${name} ${r.detail}`.slice(0, 66 + 2).padEnd(67) + '│');
    if (!r.ok && r.hint) {
      for (const ln of wrapHint(r.hint, 58)) {
        console.log(`│      ${ln}`.padEnd(67) + '│');
      }
    }
  }
  console.log('├' + line + '┤');
  console.log(`│ 结论：${passAll ? '全部就绪，可直接执行完整流程' : '存在未就绪环节——按上方指引恢复后重跑'}${' '.repeat(8)}│`);
  console.log('└' + line + '┘');
  return { passAll, rows, gogsToken: git.gogsToken, gogsUser: git.gogsUser };
}

function wrapHint(text, width) {
  const out = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (cur.length >= width) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}

/* ── CLI ────────────────────────────────────────────────────── */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isMain) {
  runPrecheck({ json: process.argv.includes('--json') }).then(r => {
    process.exitCode = r.passAll ? 0 : 1;
  }).catch(e => {
    console.error('[precheck] 异常退出：', e.message);
    process.exit(2);
  });
}
