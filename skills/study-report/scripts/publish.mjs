/**
 * publish.mjs — Storage 主 + Gogs 降级/并行 双通道发布
 *
 * 1. Storage（主）：复用 skill-storage uploader.mjs（诚实 4 级凭据链）put 报告.html
 *    → 公开 URL（study-report/<姓名>-<日期>/ 前缀）
 * 2. Gogs（降级/并行）：用自检拿到的 token 建 study-report-<姓名拼音> 仓 → push 报告+素材
 *    （建仓走 07-git.md 已验证链路：云函数幂等 token → Gogs API/web 建仓 → HTTPS push）
 * 3. ZIP：打包报告目录 → Storage put 到 downloads/skill-study-report.zip（CDN 通道探测，
 *    fmode.cn/downloads/ 映射未上线时报告为 Storage 直链，不伪造 CDN URL）
 *
 * 07-git.md 纪律：凭据零暴露 / 不伪造成功 / 状态门禁分别报告（Storage/Gogs/ZIP 三个独立状态）。
 *
 * 用法：node publish.mjs --dir <报告目录> [--name 姓名] [--gogs-token <自检所得token>]
 *                  [--gogs-user <gogs用户名>] [--no-gogs] [--no-storage]
 * 输出：JSON { storage: {...}, gogs: {...}, zip: {...} }（每通道独立 ok 状态）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const FMODE_API_BASE = (process.env.FMODE_FUNCTIONS_BASE_URL || 'https://server.fmode.cn').replace(/\/$/, '');
const GOGS_BASE = 'https://git.fmode.cn';
const UPLOADER = process.env.SKILL_STORAGE_UPLOADER
  || '/opt/data/git-repos/fmode/skill-storage/skills/fmode-storage/scripts/uploader.mjs';

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function hasFlag(flag) { return process.argv.includes(flag); }

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 180000, ...opts });
}

/** 汉字姓名 → 拼音仓库名（无拼音库，取用户名/uid 兜底，稳定即可） */
export function repoNameFor(name) {
  const pinyinMap = { 刘: 'liu', 雨: 'yu', 飏: 'yang' };
  let py = '';
  for (const ch of String(name)) py += pinyinMap[ch] || '';
  if (py) return `study-report-${py}`;
  const ascii = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const uid = (process.env.USER || 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `study-report-${ascii || uid || 'agent'}`;
}

/* ── 通道 1：Storage（主）────────────────────────────────── */
export async function publishStorage(reportPath, name, dateTag) {
  if (!fs.existsSync(UPLOADER)) {
    return { ok: false, degraded: true, reason: `skill-storage uploader 未找到：${UPLOADER}（设 SKILL_STORAGE_UPLOADER 指向）` };
  }
  const key = `study-report/${name}-${dateTag}/report.html`;
  try {
    const out = sh(process.execPath, [UPLOADER, 'put', reportPath, '--key', key], { timeout: 300000 });
    const jsonStart = out.indexOf('{');
    if (jsonStart < 0) throw new Error('uploader 输出非 JSON：' + out.slice(0, 120));
    const parsed = JSON.parse(out.slice(jsonStart));
    if (!parsed.ok || !parsed.url) throw new Error('uploader 未返回 ok/url');
    /* 公开可达性验证——不伪造成功 */
    const head = await fetch(parsed.url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    if (!head.ok) throw new Error(`上传后 HEAD 验证 ${head.status}`);
    return { ok: true, url: parsed.url, key, via: parsed.via || null };
  } catch (e) {
    return { ok: false, degraded: true, reason: String(e.message || e).slice(0, 200) };
  }
}

/* ── 通道 2：Gogs（降级/并行）────────────────────────────── */

/**
 * 幂等拿 Gogs token：优先用自检传入；否则重调云函数（07-git.md：忘密码不找回，重调即得）。
 * token 口径与 precheck 一致：云函数要 Parse sessionToken（非 sk- API token）。
 * email 用 username 派生（email 冲突会让云函数"重置内部密码失败"→502）。
 */
async function ensureGogsToken() {
  const userCfgPaths = [path.join(os.homedir(), '.fmode', 'config', 'user.json'), '/opt/data/home/.fmode/config/user.json'];
  let platformToken = process.env.FMODE_SESSION_TOKEN && !/^sk-/.test(process.env.FMODE_SESSION_TOKEN)
    ? process.env.FMODE_SESSION_TOKEN.trim() : null;
  for (const p of userCfgPaths) {
    if (platformToken) break;
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
      platformToken = cfg.sessionToken || null;
    } catch { /* next */ }
  }
  if (!platformToken) return { ok: false, reason: '无平台 sessionToken（precheck 环节1 未通过）' };

  const mobile = process.env.FMODE_MOBILE || 'user';
  const username = `fmode-${mobile}`;
  try {
    const res = await fetch(`${FMODE_API_BASE}/api/functions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        token: platformToken,
        path: '/gogs/admin/proxy',
        params: { method: 'POST', path: '/admin/users', body: { username, email: process.env.FMODE_EMAIL || `${username}@fmode.agent`, send_notify: false } },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if ((res.status === 200 || res.status === 201 || res.status === 502) && body.token && body.token.sha1) {
      return { ok: true, token: body.token.sha1, user: body.username };
    }
    return { ok: false, reason: `云函数 ${res.status}：${JSON.stringify(body).slice(0, 120)}` };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 160) };
  }
}

/** 幂等建仓：Gogs API（token）→ 已存在(409)复用 → 401 时回落 web 表单（fmode org 场景） */
async function ensureRepo(gogsToken, gogsUser, repoName, description) {
  /* 先探测是否已存在 */
  try {
    const probe = await fetch(`${GOGS_BASE}/api/v1/repos/${gogsUser}/${repoName}`, {
      headers: { Authorization: `token ${gogsToken}` }, signal: AbortSignal.timeout(15000),
    });
    if (probe.ok) return { ok: true, fullName: `${gogsUser}/${repoName}`, reused: true, ownerType: 'user' };
  } catch { /* continue to create */ }

  /* 用户名下建仓 */
  const res = await fetch(`${GOGS_BASE}/api/v1/user/repos`, {
    method: 'POST',
    headers: { Authorization: `token ${gogsToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ name: repoName, private: false, description, auto_init: false }),
  });
  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: true, fullName: body.full_name || `${gogsUser}/${repoName}`, reused: false, ownerType: 'user' };
  }
  if (res.status === 409) return { ok: true, fullName: `${gogsUser}/${repoName}`, reused: true, ownerType: 'user' };
  return { ok: false, status: res.status, reason: `建仓失败 ${res.status}` };
}

/** push 报告目录到 Gogs（凭据不进 remote URL 持久层——临时 URL 仅进程内使用） */
export function pushToGogs(repoFullName, gogsToken, gogsUser, dir, commitMsg) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-gogs-'));
  try {
    /* 复制报告目录（排除大素材），init + commit + push */
    sh('cp', ['-r', `${dir}/.`, workDir]);
    const gitDir = path.join(workDir, '.git');
    fs.rmSync(gitDir, { recursive: true, force: true }); // 报告目录若自带 .git 则去掉
    sh('git', ['init', '-q', '-b', 'main'], { cwd: workDir });
    sh('git', ['config', 'user.email', process.env.FMODE_EMAIL || 'agent@fmode.cn'], { cwd: workDir });
    sh('git', ['config', 'user.name', 'study-report-agent'], { cwd: workDir });
    fs.writeFileSync(path.join(workDir, '.gitignore'), 'node_modules/\n.DS_Store\n*.log\n');
    sh('git', ['add', '-A'], { cwd: workDir });
    sh('git', ['commit', '-q', '-m', commitMsg], { cwd: workDir });
    /* 一次性 URL：凭据只存在于本次 push 的进程参数中，不写入任何持久文件 */
    const url = `https://${gogsUser}:${gogsToken}@${GOGS_BASE.replace('https://', '')}/${repoFullName}.git`;
    /* 幂等重跑：远端已有历史 → fetch 后以远端为基叠加本次报告（不强推、不删历史，07-git 纪律） */
    let pushArgs = ['push', '-q', url, 'HEAD:main'];
    try {
      sh('git', ['fetch', '-q', url, 'main'], { cwd: workDir });
      sh('git', ['reset', '-q', '--soft', 'FETCH_HEAD'], { cwd: workDir });
      /* 远端历史之上重放工作区内容：相同内容 → 无新 commit 可跳过；有变化 → 新 commit */
      const staged = sh('git', ['status', '--porcelain'], { cwd: workDir }).trim();
      if (staged) {
        sh('git', ['add', '-A'], { cwd: workDir });
        sh('git', ['commit', '-q', '-m', commitMsg], { cwd: workDir });
      }
      pushArgs = ['push', '-q', url, 'HEAD:main'];
    } catch { /* 远端为空仓：直接首推 */ }
    sh('git', pushArgs, { cwd: workDir });
    /* ls-remote 验证（07-git.md：验证远端 SHA） */
    const remote = sh('git', ['ls-remote', url, 'HEAD'], { cwd: workDir }).trim();
    const sha = remote.split('\t')[0] || null;
    return { ok: true, repo: `https://${GOGS_BASE.replace('https://', '')}/${repoFullName}`, commit: sha };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 300) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export async function publishGogs({ dir, name, gogsToken = null, gogsUser = null }) {
  try {
    let token = gots => gots;
    let tokenRes = { ok: !!(gogsToken && gogsUser), token: gogsToken, user: gogsUser };
    if (!tokenRes.ok) {
      tokenRes = await ensureGogsToken();
      if (!tokenRes.ok) return { ok: false, degraded: true, reason: tokenRes.reason };
    }
    const repoName = repoNameFor(name);
    const repo = await ensureRepo(tokenRes.token, tokenRes.user, repoName, `${name} · 48h Agent 学习复盘报告（skill-study-report 自动发布）`);
    if (!repo.ok) return { ok: false, degraded: true, reason: repo.reason };
    void token;
    const pushed = pushToGogs(repo.fullName, tokenRes.token, tokenRes.user, dir,
      `feat: ${name} 学习复盘报告（自动发布 ${new Date().toISOString().slice(0, 10)}）`);
    if (!pushed.ok) return { ok: false, degraded: true, reason: pushed.reason, repo: repo.fullName };
    return {
      ok: true,
      repo: pushed.repo,
      commit: pushed.commit,
      reportUrl: `${pushed.repo}/blob/main/report.html`,
      reused: repo.reused,
    };
  } catch (e) {
    return { ok: false, degraded: true, reason: String(e.message || e).slice(0, 200) };
  }
}

/* ── 通道 3：ZIP → Storage downloads/（CDN 通道）──────────── */
export async function publishZip(dir, name, dateTag) {
  const zipBase = `/tmp/study-report-${name}-${dateTag}`;
  const zipPath = `${zipBase}.zip`;
  try {
    fs.rmSync(zipPath, { force: true });
    const workZipDir = path.dirname(zipPath);
    sh('cp', ['-r', dir, zipBase]);
    fs.rmSync(path.join(zipBase, 'report-data.json'), { force: true }); // ZIP 只带可复现壳
    try {
      sh('zip', ['-qr', zipPath, path.basename(zipBase)], { cwd: workZipDir });
    } catch {
      /* zip 不在 PATH → python3 zipfile 回落（幂等产物） */
      sh('python3', ['-c',
        `import shutil; shutil.make_archive(${JSON.stringify(zipPath.replace(/\.zip$/, ''))}, 'zip', ${JSON.stringify(workZipDir)}, ${JSON.stringify(path.basename(zipBase))})`]);
    }
    fs.rmSync(zipBase, { recursive: true, force: true });

    if (!fs.existsSync(UPLOADER)) {
      return { ok: false, degraded: true, localFile: zipPath, reason: 'uploader 未找到——ZIP 留本地' };
    }
    const key = `downloads/${path.basename(zipPath)}`;
    const out = sh(process.execPath, [UPLOADER, 'put', zipPath, '--key', key], { timeout: 300000 });
    const jsonStart = out.indexOf('{');
    const parsed = jsonStart >= 0 ? JSON.parse(out.slice(jsonStart)) : null;
    if (!parsed || !parsed.ok) throw new Error('ZIP 上传失败');
    /* CDN 探测：fmode.cn/downloads/ 是否映射（官方源站配置后自动生效） */
    let cdnOk = false;
    try {
      const head = await fetch(`https://fmode.cn/${key}`, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      cdnOk = head.ok;
    } catch { cdnOk = false; }
    /* 直链可达性 */
    let directOk = false;
    try {
      const head = await fetch(parsed.url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      directOk = head.ok;
    } catch { directOk = false; }
    return {
      ok: directOk || cdnOk,
      cdnUrl: cdnOk ? `https://fmode.cn/${key}` : null,
      directUrl: directOk ? parsed.url : null,
      cdnMapped: cdnOk,
      localFile: zipPath,
      note: cdnOk ? 'CDN 已映射' : 'CDN 未映射（fmode.cn/downloads/ 官方源站未配置），用 Storage 直链',
    };
  } catch (e) {
    return { ok: false, degraded: true, reason: String(e.message || e).slice(0, 200) };
  }
}

/* ── 主流程 ─────────────────────────────────────────────── */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isMain) {
  const dir = argVal('--dir', null);
  if (!dir || !fs.existsSync(path.join(dir, 'report.html'))) {
    console.error('[publish] 缺 --dir <报告目录>（须含 report.html，先跑 build-report.mjs）');
    process.exit(2);
  }
  const name = argVal('--name', (process.env.USER || 'agent'));
  const dateTag = new Date().toISOString().slice(0, 10);

  (async () => {
    const result = { name, dateTag };

    if (!hasFlag('--no-storage')) {
      console.log('[publish] 通道1 Storage（主）上传中…');
      result.storage = await publishStorage(path.join(dir, 'report.html'), name, dateTag);
      console.log(`  → ${result.storage.ok ? '✅ ' + result.storage.url : '🟡 降级：' + result.storage.reason}`);
    }

    if (!hasFlag('--no-gogs')) {
      console.log('[publish] 通道2 Gogs（降级/并行）…');
      result.gogs = await publishGogs({
        dir, name,
        gogsToken: argVal('--gogs-token', null),
        gogsUser: argVal('--gogs-user', null),
      });
      console.log(`  → ${result.gogs.ok ? '✅ ' + result.gogs.repo : '🟡 降级：' + result.gogs.reason}`);
    }

    console.log('[publish] 通道3 ZIP → Storage downloads/（CDN 探测）…');
    result.zip = await publishZip(dir, name, dateTag);
    console.log(`  → ${result.zip.ok
      ? (result.zip.cdnMapped ? '✅ CDN: ' + result.zip.cdnUrl : '✅ 直链: ' + result.zip.directUrl)
      : '🟡 ' + (result.zip.reason || '失败')}`);

    /* 状态门禁分别报告 */
    const anyOk = [result.storage, result.gogs, result.zip].filter(Boolean).some(r => r.ok);
    fs.writeFileSync(path.join(dir, 'publish-result.json'), JSON.stringify(result, null, 2));
    console.log('\n发布状态门禁：');
    console.log(`  Storage: ${result.storage ? (result.storage.ok ? '✅ 已发布' : '🟡 未发布（' + result.storage.reason.slice(0, 40) + '）') : '⏭ 跳过'}`);
    console.log(`  Gogs:    ${result.gogs ? (result.gogs.ok ? '✅ 已归档 ' + result.gogs.repo : '🟡 未归档') : '⏭ 跳过'}`);
    console.log(`  ZIP:     ${result.zip.ok ? (result.zip.cdnMapped ? '✅ CDN 分发' : '✅ Storage 直链') : '🟡 未分发'}`);
    process.exitCode = anyOk ? 0 : 2;
  })().catch(e => {
    console.error('[publish] 异常退出：', e.message);
    process.exit(2);
  });
}
