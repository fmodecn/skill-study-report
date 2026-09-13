/* ============================================================
 * lib/theme/theme.js · 运行时主题切换
 * 读取顺序：localStorage('hd-theme') → prefers-color-scheme → dark
 * 提供 window.HDTheme：{ get(), set(name), toggle() }
 * 并在顶栏 .deck-topbar 注入主题切换按钮（若存在）。
 * 普通 script，非 module，file:// 可用。
 * ============================================================ */
(function () {
  var KEY = 'hd-theme';
  var root = document.documentElement;

  /* 右上角品牌 logo：随主题切换暗/浅两图。
   * 图片在课程目录 lesson/hundun-aiceo/，按 theme.js 自身 src 反推相对路径，
   * 与页面所在深度无关（file:// 与 http 均可用）。可用 window.HD_LOGO_BASE 覆盖。 */
  var LOGO_BASE = (function () {
    try {
      if (window.HD_LOGO_BASE) return window.HD_LOGO_BASE.replace(/\/?$/, '/');
      var s = document.currentScript && document.currentScript.src;
      if (s) return new URL('../../lesson/hundun-aiceo/', s).href;
    } catch (e) {}
    return '';
  })();
  var logoImg = null;

  function current() {
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    if (saved === 'dark' || saved === 'light') return saved;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    return 'dark';
  }

  // 图片名即内容色：hundunai-dark.png = 深色内容（配浅色背景）、hundunai-light.png = 浅色内容（配深色背景）
  function logoFile(name) { return 'hundunai-' + (name === 'dark' ? 'light' : 'dark') + '.png'; }

  function apply(name) {
    root.setAttribute('data-theme', name);
    try { localStorage.setItem(KEY, name); } catch (e) {}
    if (logoImg && LOGO_BASE) logoImg.src = LOGO_BASE + logoFile(name);
  }

  function toggle() {
    apply(current() === 'dark' ? 'light' : 'dark');
  }

  // 幂等注入 logo 到顶栏右侧（deck.js buildChrome 或 DOMContentLoaded 调用）
  function ensureLogo(container) {
    if (logoImg || !LOGO_BASE) return;
    var bar = container || document.querySelector('.deck-topbar');
    if (!bar) return;
    logoImg = bar.querySelector('.hd-logo');
    if (!logoImg) {
      var right = bar.querySelector('.deck-right');
      if (!right) {
        right = document.createElement('div');
        right.className = 'deck-right';
        bar.appendChild(right);
      }
      logoImg = document.createElement('img');
      logoImg.className = 'hd-logo';
      logoImg.alt = '';
      logoImg.setAttribute('aria-hidden', 'true');
      logoImg.onerror = function () { logoImg.style.display = 'none'; }; // 图缺失不显破图
      right.appendChild(logoImg);
    }
    apply(current());
  }

  // 首帧前应用，避免闪白/闪黑
  apply(current());

  /* 主题切换按钮：图标化（暗主题显示太阳、浅主题显示月亮），放顶栏左侧 */
  var SUN_PATH = 'M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.24 5.25,10 5.11,10.79L3.34,7M3.36,17L5.12,13.23C5.26,14 5.53,14.78 5.95,15.5C6.37,16.24 6.91,16.86 7.5,17.37L3.36,17M20.65,7L18.88,10.79C18.74,10 18.47,9.23 18.05,8.5C17.63,7.78 17.1,7.15 16.5,6.64L20.65,7M20.64,17L16.5,17.36C17.09,16.85 17.62,16.22 18.04,15.5C18.46,14.77 18.73,14 18.87,13.21L20.64,17M12,22L9.59,18.56C10.33,18.83 11.14,19 12,19C12.82,19 13.63,18.83 14.37,18.56L12,22Z';
  var MOON_PATH = 'M17.75,4.09L15.22,6.03L16.13,9.09L13.5,7.28L10.87,9.09L11.78,6.03L9.25,4.09L12.44,4L13.5,1L14.56,4L17.75,4.09M21.25,11L19.61,12.25L20.2,14.23L18.5,13.06L16.8,14.23L17.39,12.25L15.75,11L17.81,10.95L18.5,9L19.19,10.95L21.25,11M18.97,15.95C19.8,15.87 20.69,17.05 20.16,17.8C19.84,18.25 19.5,18.67 19.08,19.07C15.44,22.7 9.62,22.69 5.99,19.06C2.35,15.42 2.35,9.61 5.99,5.97C6.38,5.58 6.8,5.24 7.26,4.94C8,4.42 9.17,5.3 9.1,6.13C9.04,6.74 9.07,7.35 9.22,7.95C9.78,10.19 10.83,12.28 12.29,14.05C13.84,15.92 15.77,17.35 17.92,18.21C18.28,18.35 18.64,18.47 19.02,18.55C19.23,18.58 19.46,18.57 19.68,18.55C19.78,18.55 19.88,18.56 19.98,18.55Z';
  function iconSvg(moon) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="' + (moon ? MOON_PATH : SUN_PATH) + '"/></svg>';
  }
  function createToggleBtn() {
    var btn = document.createElement('button');
    btn.className = 'theme-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', '切换主题');
    btn.title = '切换主题';
    function paint() { btn.innerHTML = iconSvg(current() === 'dark'); } // 暗主题给太阳，点它切到亮
    paint();
    btn.addEventListener('click', function () { toggle(); paint(); });
    return btn;
  }
  // 注入主题切换按钮（放顶栏左侧）
  function injectToggle() {
    var bar = document.querySelector('.deck-topbar');
    if (!bar) return;
    if (bar.querySelector('.theme-toggle')) return;
    var left = bar.querySelector('.deck-left');
    if (!left) { left = document.createElement('div'); left.className = 'deck-left'; bar.insertBefore(left, bar.firstChild); }
    left.appendChild(createToggleBtn());
  }

  window.HDTheme = { get: current, set: apply, toggle: toggle, ensureLogo: ensureLogo, createToggleBtn: createToggleBtn };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectToggle(); ensureLogo(); });
  } else {
    injectToggle();
    ensureLogo();
  }
  // 顶栏可能由 deck.js 稍后创建，兜底重试一次
  if (document.readyState === 'loading') {
    setTimeout(function () { ensureLogo(document.querySelector('.deck-topbar')); }, 300);
  }
})();
