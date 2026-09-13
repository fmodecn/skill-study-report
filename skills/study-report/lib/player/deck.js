/* ============================================================
 * lib/player/deck.js · 混沌AI院演示播放器核心
 *
 * 职责：收集 .screen → 每屏状态机 idle→playing→done；
 *       进入新屏自动播放入场动画/视频（首屏不黑屏）；↓ 先演完当前动画再切屏（门控）；
 *       动画运行中 ↓ 快进到结尾；上下键/翻页器全兼容；进度条；两级导航（读 deck-config）。
 *       鼠标支持：滚轮上/下 = 上/下一屏；侧键 前进=下章、后退=上章（防抖，兼容翻页笔）。
 *
 * 页面接入：
 *   <section class="screen" data-tl="s2">...</section>
 *   <script src=".../deck.js"></script>
 *   <script>
 *     window.SCREEN_TIMELINES = { s2: function(ctx){ var tl=gsap.timeline(); ...; return tl; } };
 *     deck.init();
 *   </script>
 * 普通 script，非 module，file:// 可用。禁止页面自写 keydown/scroll。
 * ============================================================ */
(function () {
  var screens = [];
  var current = 0;
  var total = 0;
  var cfg = null;
  var inited = false;

  /* ---------- 总控容器模式(shell)状态 ---------- */
  var shellMode = !!(window.parent && window.parent !== window); // 页面被 iframe 装载
  var shellPlan = null;   // 编排配置（deck-plan）
  var shellCur = 0;       // 当前页序号
  var shellFrames = [];   // iframe 元素（不销毁，翻回保留状态）
  var shellShown = [];    // 是否已展示过（首次展示重演入场，无白屏）
  var shellLast = [];     // 各页最近上报的进度 {index,total,state}
  var pendingGo = null;   // 容器注册前的翻章请求缓冲（防止注册竞态丢失）
  var shellFrom = 0;      // 容器模式：切片起始屏（0-based，总控 deck-range 下发）
  var shellTo = -1;       // 容器模式：切片结束屏（-1 = 整节）
  /* ---------- embed(JS 注入)模式状态 ---------- */
  var embedMode = false;      // 总控用 JS 注入单页 HTML（非 iframe）
  var embedPages = [];        // 注入后的屏信息 {page, screens, tlName}
  var embedReady = false;

  /* ---------- 工具 ---------- */
  function readConfig() {
    var el = document.querySelector('script.deck-config');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  /* 与总控容器(deck-shell)通信：postMessage 跨源/跨 file:// 均可用 */
  function postShell(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (e) {}
  }

  function fmt(n, dec, sep) {
    var s = n.toFixed(dec == null ? 0 : dec);
    if (sep) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    return s;
  }

  function makeCtx(s) {
    var el = s.el;
    return {
      el: el,
      q: function (sel) { return el.querySelector(sel); },
      qAll: function (sel) { return el.querySelectorAll(sel); },
      // 数字滚动，返回 gsap tween，可用 tl.add(ctx.count(...), pos)
      count: function (sel, to, opts) {
        opts = opts || {};
        var node = el.querySelector(sel);
        if (!node || !window.gsap) return null;
        var obj = { val: 0 };
        var target = (opts.to != null) ? opts.to : to;
        var tw = window.gsap.to(obj, {
          val: target,
          duration: opts.duration || 1.2,
          ease: opts.ease || 'power1.out',
          onUpdate: function () { node.textContent = fmt(obj.val, opts.dec || 0, opts.sep); }
        });
        return tw;
      }
    };
  }

  /* ---------- 状态 ---------- */
  function collect() {
    var els = Array.prototype.slice.call(document.querySelectorAll('.screen'));
    screens = els.map(function (el) {
      var tlKey = el.getAttribute('data-tl');
      return {
        el: el,
        tlKey: tlKey,
        hasTL: !!(tlKey && window.SCREEN_TIMELINES && typeof window.SCREEN_TIMELINES[tlKey] === 'function'),
        video: el.querySelector('video[data-gate]'),
        auto: el.hasAttribute('data-gate-autoplay'),
        state: 'idle',
        tl: null
      };
    });
    total = screens.length;
  }

  /* ---------- 展示 ---------- */
  function showScreen(i) {
    screens.forEach(function (s, j) {
      s.el.style.visibility = (j === i) ? 'visible' : 'hidden';
      // 根因修复：`.screen[data-tl].in > .s-wrap { visibility: visible }`（base.css）是 .s-wrap 的
      // 直接声明，会覆盖从屏级继承的 hidden。动画播完 .in 类残留 → 旧屏屏级 hidden 但 .s-wrap
      // 仍 visible，内容叠在新屏上（旧屏盖新屏的根因）。此处对 .s-wrap 直接强制隐藏/恢复。
      var wrap = s.el.querySelector('.s-wrap');
      if (wrap) wrap.style.visibility = (j === i) ? '' : 'hidden';
    });
    current = i;
    updateProgress();
    highlightTab();
  }

  // 屏激活：进入新一页/新屏直接走入场动画加载（不黑屏）。
  // 有时间线 → 自动播放；autoplay 视频 → 自动播；data-gate 视频 → 保持 idle 等 ↓；
  // 无动画 → 直接视为完成。↓ 在动画运行中可快进（见 next）。
  function activate(s) {
    if (s.state !== 'idle') return;
    if (s.hasTL) { playTimeline(s); return; }
    if (s.video && s.auto) { playVideo(s); return; }
    if (s.video) return;               // data-gate 视频：保持 idle，等 ↓ 播放
    s.state = 'done'; updateProgress();
  }

  /* ---------- 动画 / 视频门控 ---------- */
  function playTimeline(s) {
    if (!s.hasTL) return false;
    s.el.classList.add('in');
    var fn = window.SCREEN_TIMELINES[s.tlKey];
    var ctx = makeCtx(s);
    var tl = null;
    try { tl = fn(ctx); } catch (e) { tl = null; }
    if (!tl || !window.gsap) { s.state = 'done'; updateProgress(); return false; }
    s.tl = tl;
    s.state = 'playing';
    tl.eventCallback('onComplete', function () {
      // 有时间线 + data-gate-autoplay：时间线播完自动接播视频（再按 ↓ 才切屏）
      if (s.video && s.auto) { playVideo(s); return; }
      s.state = 'done'; updateProgress();
    });
    tl.play();
    updateProgress();
    return true;
  }

  function playVideo(s) {
    var v = s.video;
    if (!v) return;
    var ended = function () { s.state = 'done'; updateProgress(); };
    v.removeEventListener('ended', ended);
    v.addEventListener('ended', ended);
    var p = v.play();
    if (p && p.catch) p.catch(function () { s.state = 'done'; updateProgress(); });
    s.state = 'playing';
    updateProgress();
  }

  function resetScreen(s) {
    if (s.tl) {
      // 先播到结尾让 from-tween 渲染到最终态（opacity 1），再 kill：
      // 直接 kill 一个播放中的 timeline 会残留内联 opacity:0（immediateRender），
      // 且后续新建的 timeline 无法推进 → 重演 / jump / prev 时整屏空白（CBEC p0/p1 实测）。
      try { s.tl.progress(1); } catch (e) {}
      try { s.tl.kill(); } catch (e) {}
      s.tl = null;
    }
    s.el.classList.remove('in');
    s.state = 'idle';
    if (s.video) { s.video.pause(); s.video.currentTime = 0; }
  }

  /* ---------- 导航动作 ---------- */
  function next() {
    if (current >= total) return;
    var s = screens[current];
    if (s.state === 'done') { advance(); return; }
    if (s.state === 'playing') {
      // 入场动画运行中按 ↓：快进到结尾并切下一屏（新屏入场自动播放）；视频保持本屏待重播
      if (s.video && !s.video.paused) { s.video.currentTime = s.video.duration; return; }
      if (s.tl) s.tl.progress(1);
      advance();
      return;
    }
    // idle（正常已被 activate 自动播放；防御 data-gate 视频屏）
    if (s.hasTL && playTimeline(s)) return;
    if (s.video) { playVideo(s); return; }
    s.state = 'done';
    advance();
  }

  function advance() {
    // 容器切片：当前屏已是切片结束屏 → 直接翻章（交给总控切下一节），不进入切片外屏
    if (shellTo >= 0 && current >= shellTo) { nextChapter(); return; }
    if (current < total - 1) {
      showScreen(current + 1);
      activate(screens[current]);      // showScreen 已把 current 指向新屏 → 自动播放入场
    } else {
      nextChapter();
    }
  }

  function prev() {
    // 容器切片：当前屏已是切片起始屏 → 直接翻上一章
    if (shellFrom > 0 && current <= shellFrom) { prevChapter(); return; }
    if (current > 0) {
      resetScreen(screens[current]);
      current--;
      resetScreen(screens[current]);
      showScreen(current);
      activate(screens[current]);      // 上一屏重演入场（可重演）
    } else {
      prevChapter();
    }
  }

  function jump(i) {
    // 容器切片：跳转范围钳制在 [from, to]
    if (shellTo >= 0) i = Math.max(shellFrom, Math.min(i, shellTo));
    if (i < 0 || i >= total) return;
    resetScreen(screens[current]);
    current = i;
    resetScreen(screens[current]);
    showScreen(current);
    activate(screens[current]);
  }

  /* ---------- 章节导航 ---------- */
  function goFile(file, dir) {
    if (!file) return;
    if (shellMode) {
      // 容器模式：翻章请求交给总控（总控按 plan 顺序编排），不在 iframe 内跳文件
      pendingGo = { type: 'deck-go', file: file, dir: dir };
      postShell(pendingGo);
      return;
    }
    var cur = location.pathname.split('/').pop();
    if (file === cur) { dir > 0 ? jump(0) : jump(total - 1); return; }
    location.href = file;
  }
  function nextChapter() {
    if (embedMode && embedReady) { embedJumpSection(1); return; }
    goFile(cfg ? cfg.next : null, 1);
  }
  function prevChapter() {
    if (embedMode && embedReady) { embedJumpSection(-1); return; }
    goFile(cfg ? cfg.prev : null, -1);
  }

  /* embed(JS注入)模式：节级跳转统一走这里（←→/侧键/触摸横滑/末屏翻章）。
   * 节 = plan.pages 一项；embed 下所有屏 flat 注入，按节累计屏数定位「该节第一屏」。
   * 不用 next()/prev()（那在 embed 下是切屏，不是切节）。 */
  function embedSectionIndex() {
    var acc = 0;
    for (var q = 0; q < shellPlan.pages.length; q++) {
      var cnt = (embedPages[q] && embedPages[q].count) || 0;
      if (current < acc + cnt) return q;
      acc += cnt;
    }
    return shellPlan.pages.length - 1;
  }
  function embedJumpSection(dir) {
    var sec = embedSectionIndex() + dir;
    if (sec < 0 || sec >= shellPlan.pages.length) return;   // 边界节不翻，与 iframe showPage 一致
    var target = 0;
    for (var q = 0; q < sec; q++) target += (embedPages[q] && embedPages[q].count) || 0;
    jump(target);
  }

  /* ---------- 界面 ---------- */
  function ensureThemeBtn() {
    if (document.querySelector('.theme-toggle')) return;
    var topbar = document.querySelector('.deck-topbar');
    if (!topbar) return;
    var btn = null;
    // 优先 theme.js 的图标按钮（太阳/月亮），缺失时退化为文字兜底
    if (window.HDTheme && window.HDTheme.createToggleBtn) {
      btn = window.HDTheme.createToggleBtn();
    } else {
      btn = document.createElement('button');
      btn.className = 'theme-toggle';
      btn.type = 'button';
      btn.textContent = '主题';
      btn.addEventListener('click', function () { if (window.HDTheme) window.HDTheme.toggle(); });
    }
    var left = topbar.querySelector('.deck-left');
    if (!left) { left = document.createElement('div'); left.className = 'deck-left'; topbar.insertBefore(left, topbar.firstChild); }
    left.appendChild(btn);
  }

  function highlightTab() {
    if (!cfg) return;
    var tabs = document.querySelectorAll('.deck-tab');
    tabs.forEach(function (b) {
      b.classList.toggle('cur', b.getAttribute('data-ch') === cfg.page.id);
    });
    scrollActiveTabIntoView();
  }

  /* 顶栏章节/页面 tab 自动横向滚动：把高亮当前 tab 滚动到居中（不触边）。
   * 溢出检测用 scrollWidth（横向不溢出时忽略，含窄屏折叠面板纵向列）。 */
  function scrollActiveTabIntoView() {
    var nav = document.querySelector('.deck-tabs');
    var cur = document.querySelector('.deck-tab.cur');
    if (!nav || !cur) return;
    if (nav.scrollWidth <= nav.clientWidth) return;          // 无需滚动
    var navRect = nav.getBoundingClientRect();
    var curRect = cur.getBoundingClientRect();
    var target = nav.scrollLeft + (curRect.left + curRect.width / 2) - (navRect.left + navRect.width / 2);
    var max = nav.scrollWidth - nav.clientWidth;
    target = Math.max(0, Math.min(target, max));             // 不触边：钳制在可滚范围
    if (Math.abs(nav.scrollLeft - target) > 1) {
      nav.scrollTo({ left: target, behavior: 'smooth' });
    }
  }

  function buildChrome() {
    if (shellMode) return;   // 容器模式：顶栏/进度条由总控渲染，页面只保留 .screen 内容
    var topbar = document.querySelector('.deck-topbar');
    if (!topbar) { topbar = document.createElement('div'); topbar.className = 'deck-topbar'; document.body.appendChild(topbar); }
    if (cfg && cfg.chapters && !topbar.querySelector('.deck-tabs')) {
      var nav = document.createElement('nav');
      nav.className = 'deck-tabs';
      cfg.chapters.forEach(function (ch) {
        var b = document.createElement('button');
        b.className = 'deck-tab' + (ch.id === cfg.page.id ? ' cur' : '');
        b.type = 'button';
        b.setAttribute('data-ch', ch.id);
        b.textContent = ch.title;
        b.addEventListener('click', function () { goFile(ch.file, 1); });
        nav.appendChild(b);
      });
      topbar.appendChild(nav);
    }
    ensureThemeBtn();
    var right = topbar.querySelector('.deck-right');
    if (!right) { right = document.createElement('div'); right.className = 'deck-right'; topbar.appendChild(right); }
    // 右上角品牌 logo（theme.js 注入，随主题切换暗/浅图）
    if (window.HDTheme && window.HDTheme.ensureLogo) window.HDTheme.ensureLogo(right);

    var bottom = document.querySelector('.deck-bottom');
    if (!bottom) {
      bottom = document.createElement('div');
      bottom.className = 'deck-bottom';
      document.body.appendChild(bottom);
      var prog = document.createElement('div');
      prog.className = 'deck-progress';
      var bar = document.createElement('div');
      bar.className = 'bar';
      prog.appendChild(bar);
      bottom.appendChild(prog);
      var pos = document.createElement('span');
      pos.className = 'deck-pos';
      bottom.appendChild(pos);
      if (cfg && cfg.page) {
        var pn = document.createElement('span');
        pn.className = 'deck-pagename';
        pn.textContent = cfg.page.title;
        bottom.appendChild(pn);
      }
    }
  }

  function updateProgress() {
    var pct = total ? (current / total) * 100 : 0;
    var bar = document.querySelector('.deck-progress .bar');
    if (bar) bar.style.width = pct + '%';
    var pos = document.querySelector('.deck-pos');
    if (pos) pos.textContent = (current + 1) + ' / ' + total;
    // 容器模式：把本页进度上报总控（总控据此算全局进度条）
    if (shellMode) {
      var s = screens[current] || null;
      postShell({ type: 'deck-progress', index: current, total: total, state: s ? s.state : 'done' });
    }
    // embed 模式：屏进度变化同步总控 chrome
    if (embedMode && embedReady) renderShellChrome();
  }

  /* ---------- 输入 ---------- */
  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      var k = e.key;
      if (k === 'ArrowDown' || k === 's' || k === 'S' || k === 'PageDown' || k === ' ') {
        e.preventDefault(); next();
      } else if (k === 'ArrowUp' || k === 'w' || k === 'W' || k === 'PageUp') {
        e.preventDefault(); prev();
      } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
        e.preventDefault(); nextChapter();
      } else if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
        e.preventDefault(); prevChapter();
      } else if (k === 'Home') {
        e.preventDefault(); jump(0);
      } else if (k === 'End') {
        e.preventDefault(); jump(total - 1);
      }
    });
  }

  function bindClick() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.closest && (t.closest('a') || t.closest('button') || t.closest('.deck-topbar') || t.closest('.deck-bottom'))) return;
      if (e.clientX > window.innerWidth * 0.78 && e.clientX < window.innerWidth) next();
    });
  }

  function bindMouse() {
    // 滚轮：累计方向，超过阈值触发一次，冷却期防连击（轨迹板/鼠标均稳定）
    var wheelAcc = 0, lastDir = 0, wheelLock = 0;
    var STEP = 60, COOLDOWN = 550;
    document.addEventListener('wheel', function (e) {
      var t = e.target;
      // 顶栏章节/页面 tab 上滚轮 → 横向滚动 tabs（顶栏 hover 本就不翻屏；横向不溢出时忽略）
      if (t && t.closest && t.closest('.deck-tabs')) {
        var nav = t.closest('.deck-tabs');
        if (nav.scrollWidth > nav.clientWidth) {
          e.preventDefault();
          var step = e.deltaMode === 0 ? (e.deltaY || e.deltaX) : e.deltaY * 40;
          nav.scrollLeft += step;
        }
        return;
      }
      if (t && t.closest && (t.closest('a') || t.closest('button') || t.closest('.deck-topbar') || t.closest('.deck-bottom'))) return;
      var now = Date.now();
      if (now - wheelLock < COOLDOWN) return;
      if (e.deltaY === 0) return;
      var dir = e.deltaY > 0 ? 1 : -1;          // 下滚 = 下一屏，上滚 = 上一屏
      wheelAcc = (lastDir === dir) ? wheelAcc + e.deltaY : e.deltaY;
      lastDir = dir;
      if (Math.abs(wheelAcc) < STEP) return;    // 未到阈值先攒着
      wheelAcc = 0; wheelLock = now;
      e.preventDefault();
      if (dir > 0) next(); else prev();
    }, { passive: false });
    // 鼠标侧键：button 3(前进) → 下章，button 4(后退) → 上章（auxclick/mouseup 双绑兼容，防抖）
    var lastSide = 0;
    function side(e) {
      if (e.button !== 3 && e.button !== 4) return;
      var t = e.target;
      if (t && t.closest && (t.closest('a') || t.closest('button') || t.closest('.deck-topbar') || t.closest('.deck-bottom'))) return;
      var now = Date.now();
      if (now - lastSide < 450) return;
      lastSide = now;
      e.preventDefault();
      if (e.button === 3) nextChapter(); else prevChapter();
    }
    document.addEventListener('auxclick', side);
    document.addEventListener('mouseup', side);
  }

  function bindTouch() {
    // 触摸手势：上滑/下滑 = 下/上一屏（触屏习惯：上滑进下一页），左滑/右滑 = 下/上一章（与方向键一致）。
    // 用 Touch Events 而非 Pointer Events：touchmove + passive:false 才能真正 preventDefault
    // 阻止浏览器原生滚动/缩放；pointermove 的 preventDefault 对滚动无效（需 touch-action CSS，
    // 而全局 touch-action:none 会破坏 chat-window/group-chat 内部滚动）。
    if (!('ontouchstart' in window)) return;     // 无触摸能力（桌面）直接跳过，不打扰鼠标
    var startX = 0, startY = 0, axis = 0;        // axis: 0=未锁定 1=水平 2=垂直
    var tracking = false;
    var touchLock = 0;
    var THRESHOLD = 50, COOLDOWN = 550;          // 阈值 50px、冷却 550ms（与滚轮一致）

    function isIgnored(t) {                       // 与 wheel/click 相同的忽略集，避免误触
      return !!(t && t.closest &&
        (t.closest('a') || t.closest('button') || t.closest('.deck-topbar') || t.closest('.deck-bottom')));
    }

    document.addEventListener('touchstart', function (e) {
      if (isIgnored(e.target)) return;            // 交互元素不接管
      if (e.touches.length > 1) return;            // 多点（捏合缩放）不接管
      tracking = true;
      axis = 0;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    });

    document.addEventListener('touchmove', function (e) {
      if (!tracking) return;
      if (e.touches.length > 1) { tracking = false; return; }   // 双指出现 = 放弃手势
      var t = e.touches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      if (axis === 0) {
        // 方向锁定：位移超 8px 判定轴向（水平/垂直二选一），防斜滑误触发
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 1 : 2;
      }
      e.preventDefault();                          // 轴向锁定后才阻断原生滚动/缩放（passive:false）
    }, { passive: false });

    function finish(e) {
      if (!tracking) return;
      tracking = false;
      if (axis === 0) return;                      // 未到锁定阈值 = tap，放行 click
      var now = Date.now();
      if (now - touchLock < COOLDOWN) return;      // 防连击
      var t = e.changedTouches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      if (axis === 1) {                            // 水平：左滑=下章，右滑=上章
        if (Math.abs(dx) < THRESHOLD) return;
        touchLock = now;
        if (dx < 0) nextChapter(); else prevChapter();
      } else {                                     // 垂直：上滑=下一屏，下滑=上一屏
        if (Math.abs(dy) < THRESHOLD) return;
        touchLock = now;
        if (dy < 0) next(); else prev();
      }
    }
    document.addEventListener('touchend', finish);
    document.addEventListener('touchcancel', function () { tracking = false; });
  }

  /* ---------- 入口 ---------- */
  function init(opts) {
    if (inited) return;
    inited = true;
    opts = opts || {};
    window.addEventListener('message', onPageMessage);
    if (opts.mode === 'shell') { initShell(opts); return; }
    cfg = readConfig();
    collect();
    if (total === 0) return;
    screens.forEach(function (s) {
      s.el.style.position = 'absolute';
      s.el.style.inset = '0';
    });
    buildChrome();
    bindKeys();
    bindClick();
    bindMouse();
    bindTouch();
    showScreen(0);
    activate(screens[0]);              // 首屏自动播放入场，不黑屏
  }

  // 安全网：若页面未显式 init，DOM 就绪后自动启动
  function auto() {
    if (inited) return;
    if (document.querySelectorAll('.screen').length) init();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', auto);
  } else {
    setTimeout(auto, 0);
  }

  /* ============================================================
   * 总控容器模式（shell）：总控页用 iframe 加载多页 + 预加载无缝衔接 + 导航可编排。
   *
   * 用法（总控页，如 course/deck-shell.html）：
   *   <script type="application/json" class="deck-plan">{ "title": "...", "pages":[ {"file":"demo/p1.html","title":"01 ..."}, ... ] }</script>
   *   <script src=".../deck.js"></script>
   *   <script> deck.init({ mode: 'shell', planEl: '.deck-plan' }); </script>
   *
   * - plan.pages[].file 相对总控页；iframe 不销毁，翻回保留状态；预加载下一页（隐藏）→ 翻页无白屏。
   * - 页内 deck 保持单页模式不变（可独立打开）；容器内通过 postMessage 上报进度、转发翻章请求。
   * - file:// 双击读内嵌 JSON（零 fetch）；http 下可加 ?plan=plans/xxx.json 切换编排（fetch 失败回退内嵌）。
   * ============================================================ */

  function urlParam(name) {
    try {
      var m = location.search.match(new RegExp('[?&]' + name + '=([^&]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  function readPlan(opts) {
    if (opts.plan && typeof opts.plan === 'object' && opts.plan.pages) return opts.plan;
    var url = opts.planUrl || urlParam('plan');
    if (url && location.protocol !== 'file:') {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);       // 同步，保持零构建的确定性（仅 http 生效）
        xhr.send(null);
        if (xhr.status >= 200 && xhr.status < 300) {
          var p = JSON.parse(xhr.responseText);
          if (p && p.pages) return p;
        }
      } catch (e) {}
    }
    var el = opts.planEl ? document.querySelector(opts.planEl) : document.querySelector('script.deck-plan');
    if (el) {
      try {
        var p2 = JSON.parse(el.textContent);
        if (p2 && p2.pages) return p2;
      } catch (e) {}
    }
    return null;
  }

  function initShell(opts) {
    var plan = readPlan(opts);
    if (!plan) {
      var err = document.createElement('div');
      err.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;'
        + 'font:16px var(--font-mono);color:var(--text-3);background:var(--bg-0);text-align:center;padding:40px;';
      err.textContent = '缺少编排配置：请在总控页内嵌 <script class="deck-plan"> JSON，或 http 下加 ?plan=plans/xxx.json。';
      document.body.appendChild(err);
      return;
    }
    shellPlan = plan;
    window.addEventListener('message', onShellMsg);
    buildShellChrome(plan);
    bindShellKeys();
    if (isMobileUA() || urlParam('mobile') === '1') buildFullscreenBtn();   // 手机端：右下角全屏切换（?mobile=1 供桌面调试）
    // embed 模式：plan 任一页带 picks（精确选屏）→ 走 JS 注入，不走 iframe
    var useEmbed = plan.pages.some(function (p) { return p && p.picks; });
    if (useEmbed) { initEmbed(); return; }
    showPage(0);
  }

  function buildShellChrome(plan) {
    var isNarrow = isMobileUA() || urlParam('mobile') === '1' || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    var topbar = document.createElement('div');
    topbar.className = 'deck-topbar shell-topbar' + (isNarrow ? ' shell-collapsed' : '');
    var left = document.createElement('div');
    left.className = 'deck-left';
    var title = document.createElement('span');
    title.className = 'shell-title';
    title.textContent = plan.title || '演示';
    left.appendChild(title);
    var btn = null;
    if (window.HDTheme && window.HDTheme.createToggleBtn) {
      btn = window.HDTheme.createToggleBtn();
      btn.addEventListener('click', function () { setTimeout(broadcastTheme, 0); });
    } else {
      btn = document.createElement('button');
      btn.className = 'theme-toggle';
      btn.type = 'button';
      btn.textContent = '主题';
      btn.addEventListener('click', function () {
        var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', cur);
        broadcastTheme();
      });
    }
    left.insertBefore(btn, title);           // 主题按钮最左
    // 窄屏：汉堡按钮（折叠导航），点击展开/收起节列表
    if (isNarrow) {
      var burger = document.createElement('button');
      burger.className = 'shell-burger';
      burger.type = 'button';
      burger.setAttribute('aria-label', '展开页面导航');
      burger.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 5h15M2.5 10h15M2.5 15h15"/></svg>';
      burger.addEventListener('click', function (ev) {
        ev.stopPropagation();
        topbar.classList.toggle('shell-open');
      });
      left.insertBefore(burger, left.firstChild);
      // 点击非折叠区关闭
      document.addEventListener('click', function (e) {
        if (!topbar.classList.contains('shell-open')) return;
        if (!topbar.contains(e.target)) topbar.classList.remove('shell-open');
      });
    }
    topbar.appendChild(left);
    var nav = document.createElement('nav');
    nav.className = 'deck-tabs';
    nav.setAttribute('aria-label', '页面导航');
    plan.pages.forEach(function (p, i) {
      var b = document.createElement('button');
      b.className = 'deck-tab shell-tab' + (i === 0 ? ' cur' : '');
      b.type = 'button';
      b.textContent = p.title || ('第 ' + (i + 1) + ' 页');
      b.title = p.file || '';
      b.addEventListener('click', function () {
        if (embedMode && embedReady) {
          // embed：跳到该节第一屏
          var acc = 0, target = 0;
          for (var q = 0; q < i; q++) { acc += (embedPages[q] && embedPages[q].count) || 0; }
          target = acc;
          jump(target);
        } else {
          showPage(i);
        }
        topbar.classList.remove('shell-open');   // 选完收起（窄屏）
      });
      nav.appendChild(b);
    });
    topbar.appendChild(nav);
    var right = document.createElement('div');
    right.className = 'deck-right';
    topbar.appendChild(right);
    document.body.appendChild(topbar);
    if (window.HDTheme && window.HDTheme.ensureLogo) window.HDTheme.ensureLogo(right);

    var bottom = document.createElement('div');
    bottom.className = 'deck-bottom shell-bottom';
    var prog = document.createElement('div');
    prog.className = 'deck-progress';
    var bar = document.createElement('div');
    bar.className = 'bar';
    prog.appendChild(bar);
    bottom.appendChild(prog);
    var pos = document.createElement('span');
    pos.className = 'deck-pos shell-pos';
    bottom.appendChild(pos);
    var pn = document.createElement('span');
    pn.className = 'deck-pagename shell-pagename';
    bottom.appendChild(pn);
    var prevB = document.createElement('button');
    prevB.className = 'shell-navbtn';
    prevB.type = 'button';
    prevB.textContent = '‹ 上一页';
    prevB.addEventListener('click', function () {
      if (embedMode && embedReady) prev(); else showPage(shellCur - 1);
    });
    bottom.appendChild(prevB);
    var nextB = document.createElement('button');
    nextB.className = 'shell-navbtn';
    nextB.type = 'button';
    nextB.textContent = '下一页 ›';
    nextB.addEventListener('click', function () {
      if (embedMode && embedReady) next(); else showPage(shellCur + 1);
    });
    bottom.appendChild(nextB);
    document.body.appendChild(bottom);
  }

  function postToFrame(fr, msg) {
    try { fr.contentWindow.postMessage(msg, '*'); } catch (e) {}
  }

  /* ============================================================
   * embed(JS 注入)模式：把单页 HTML 拉为字符串，DOMParser 解析，
   * 按 picks 精确选屏注入总控 DOM；timeline 合并进全局；节样式注入。
   * 相比 iframe：可精确到任意屏组合、可跨节跳着选屏、预渲染可控。
   * ============================================================ */
  function fetchText(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) cb(null, xhr.responseText);
      else cb('HTTP ' + xhr.status);
    };
    xhr.onerror = function () { cb('net'); };
    xhr.send(null);
  }

  // 把节 HTML 的相对资源路径转绝对（相对该节文件所在目录；用 URL 解析避免拼接错误）
  function absolutize(baseURL, el, attr) {
    var v = el.getAttribute(attr);
    if (!v || /^(https?:|data:|blob:|#)/.test(v)) return;
    // 页面内锚点 href="#s1-..." 保留
    if (v.charAt(0) === '#') return;
    try {
      var abs = new URL(v, baseURL).href;
      el.setAttribute(attr, abs);
    } catch (e) {}
  }

  // 提取节内联 <style>（含 style.css 内容合并）
  function extractStyles(doc, baseURL, out) {
    var links = doc.querySelectorAll('link[rel="stylesheet"]');
    var inlines = doc.querySelectorAll('style');
    links.forEach(function (l) {
      var href = l.getAttribute('href') || '';
      absolutize(baseURL, l, 'href');
      out.push(l.outerHTML);
    });
    inlines.forEach(function (s) { out.push(s.outerHTML); });
  }

  // 提取 SCREEN_TIMELINES（把 IIFE 的 TL 注册名改成节级命名，避免全局覆盖）
  function extractTimeline(html, ns) {
    // 找出 window.SCREEN_TIMELINES = (function(){...})(); 整段
    var m = html.match(/window\.SCREEN_TIMELINES\s*=\s*\(function[\s\S]*?\}\)\(\);/);
    if (!m) return '';
    return m[0].replace(/window\.SCREEN_TIMELINES\s*=\s*/, 'window["' + ns + '"] = ');
  }

  // 执行节的内联脚本（数据/渲染/初始化），让动态屏在 shell 里也能渲染。
  // 跳过：外链 src、deck-config JSON、SCREEN_TIMELINES 块、deck.init 引导块。
  // 数据与函数挂到 window（与单页一致）；脚本在 DOMParser 解析后的 doc 上查询 DOM
  // 时可能拿到 doc 而非总控 DOM——因此这些脚本里的 DOM 初始化统一改由 timeline
  // 在总控 DOM 上触发（页内已有的 window 数据声明与纯函数保持原样执行即可）。
  function execInlineScripts(doc, pageFile) {
    var scripts = doc.querySelectorAll('script:not([src])');
    Array.prototype.forEach.call(scripts, function (sc) {
      if (sc.getAttribute('type') === 'application/json') return; // JSON 数据块，非 JS
      var code = sc.textContent || '';
      if (!code.trim()) return;
      if (/deck-config/.test(code)) return;                 // 页内导航 JSON，不执行
      // SCREEN_TIMELINES 定义段已由 extractTimeline 改名执行（window["__EMB_TL_N"]）。
      // 本函数执行节的数据/渲染脚本，但做两处安全化：
      //   1) 挖掉 SCREEN_TIMELINES 段与 deck.init 引导（embed 由总控接管）
      //   2) 把 document.getElementById( 替换为安全版本：找不到返回 null（让
      //      立即渲染用 if(el) 守卫自然跳过，不抛错）；把 document.addEventListener(
      //      替换为空操作（embed 键盘由总控接管，避免页面级监听冲突）
      // 这样数据声明、window.X 赋值、函数定义都正常执行挂到全局，供 timeline 渲染。
      if (!window.__embGEL) {
        // 安全 getElementById：找不到返回「幽灵元素」（属性/方法访问一律 noop），
        // 让 embed 下找不到容器的立即渲染不抛错（数据声明仍执行，渲染由 timeline 接管）。
        window.__embGEL = function (id) {
          var el = document.getElementById(id);
          if (el) return el;
          if (window.__embGhost) return window.__embGhost;
          window.__embGhost = new Proxy({}, {
            get: function (t, k) {
              if (k === 'children') return [];
              if (k === 'style') return new Proxy({}, { get: function () { return ''; }, set: function () { return true; } });
              return function () {};
            },
            set: function () { return true; }
          });
          return window.__embGhost;
        };
        window.__embNoop = function () {};
      }
      var execCode = code.replace(/window\.SCREEN_TIMELINES\s*=\s*\(function[\s\S]*?\}\)\(\);/g, '')
        .replace(/deck\.init\s*\(\s*\{?\s*\}?\s*\)\s*;/g, '')
        .replace(/document\.documentElement\.classList\.add\([^)]*\)\s*;?/g, '')
        .replace(/document\.getElementById\s*\(/g, 'window.__embGEL(')
        .replace(/document\.addEventListener\s*\(/g, 'window.__embNoop(');
      if (!execCode.trim()) return;
      try {
        // 间接 eval 全局作用域执行：数据声明与函数声明挂到 window，
        // 供 SCREEN_TIMELINES 里的渲染函数调用。
        (0, eval)(execCode);
      } catch (e) {
        console.error('[embed] inline ' + (pageFile || ''), e);
      }
    });
  }

  // 收集一节的屏 DOM（按 picks 或整节），并注入总控 stage
  function embedChapter(page, i, done) {
    var file = page.file;
    var baseURL = null;
    try { baseURL = new URL(file, location.href).href; } catch (e) {}
    fetchText(file, function (err, html) {
      if (err) { console.error('[embed] ' + file + ' ' + err); if (done) done(); return; }
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var ns = '__EMB_TL_' + i;
      // 1. 注入节样式（link + style，基于节绝对 URL 解析相对路径）
      var styles = [];
      extractStyles(doc, baseURL, styles);
      if (styles.length) {
        var styleBox = document.getElementById('emb-styles');
        if (!styleBox) {
          styleBox = document.createElement('div');
          styleBox.id = 'emb-styles';
          styleBox.style.display = 'none';
          document.head.appendChild(styleBox);
        }
        styleBox.insertAdjacentHTML('beforeend', styles.join('\n'));
      }
      // 2. 注册节 timeline（节级命名空间，避免不同节同名 data-tl 互相覆盖）
      var tlCode = extractTimeline(html, ns);
      if (tlCode) {
        try {
          var fn = new Function(tlCode);
          fn();
        } catch (e) { console.error('[embed] TL ' + file, e); }
        // 合并进全局 SCREEN_TIMELINES：key = ns + '_' + 原key（如 __EMB_TL_11_s1）
        if (window[ns]) {
          window.SCREEN_TIMELINES = window.SCREEN_TIMELINES || {};
          var tlObj = window[ns];
          Object.keys(tlObj).forEach(function (k) {
            window.SCREEN_TIMELINES[ns + '_' + k] = tlObj[k];
          });
          delete window[ns];
        }
      }
      // 3. 按 picks 选屏注入 stage（屏 data-tl 改为节前缀命名，避免全局 timeline key 冲突）
      var all = doc.querySelectorAll('section.screen');
      var picks = page.picks || null;
      var chosen = [];
      if (picks && picks.length) {
        picks.forEach(function (idx) { if (all[idx]) chosen.push(all[idx]); });
      } else {
        chosen = Array.prototype.slice.call(all);
      }
      var stage = document.querySelector('.shell-stage') || document.body;
      chosen.forEach(function (sec) {
        // 克隆到总控 DOM（保留原样，动画/计时靠 SCREEN_TIMELINES + gsap）
        var clone = doc.importNode(sec, true);
        // data-tl 加节前缀：__E<i>_<原tl>，对应下方 timeline 的节级命名
        var t = clone.getAttribute('data-tl');
        if (t) clone.setAttribute('data-tl', ns + '_' + t);
        // 资源绝对化（基于节 HTML 绝对 URL）——video 直接 src 与 source 子元素都处理
        clone.querySelectorAll('img').forEach(function (im) { absolutize(baseURL, im, 'src'); });
        clone.querySelectorAll('video[src]').forEach(function (vd) { absolutize(baseURL, vd, 'src'); });
        clone.querySelectorAll('video source').forEach(function (im) { absolutize(baseURL, im, 'src'); });
        clone.querySelectorAll('a[href]').forEach(function (a) { absolutize(baseURL, a, 'href'); });
        stage.appendChild(clone);
      });
      // 3b. 注入页面级 JSON 数据块（如 tt-data / 商品数据），供动态屏 IIFE 读取。
      //     deck-config 是页内导航，不注入；id 冲突时第一个生效（跨节数据各自独立）。
      doc.querySelectorAll('script[type="application/json"]').forEach(function (jb) {
        if (/deck-config/.test(jb.textContent || '')) return;
        var jid = jb.getAttribute('id');
        if (jid && document.getElementById(jid)) return;   // 已注入（首章优先）
        stage.appendChild(doc.importNode(jb, true));
      });
      // 4. 注入完成后执行节的其他内联脚本（数据/渲染函数/初始化）。
      //    此刻页面的 JSON 数据块与各 grid/详情容器已在总控 DOM，页内 IIFE
      //    （KOC 矩阵 / 商品墙 / 六国商品等立即渲染）能正常找到目标元素。
      //    排除：deck-config JSON、SCREEN_TIMELINES 块、外链脚本、deck.init 引导块。
      execInlineScripts(doc, file);
      embedPages[i] = { page: page, count: chosen.length };
      if (done) done();
    });
  }

  function checkEmbedReady() {
    var loaded = embedPages.filter(function (p) { return p; }).length;
    if (loaded === shellPlan.pages.length) {
      // 全部注入完成 → 用单页模式播放（屏状态机），进度按所有注入屏
      embedReady = true;
      collect();
      if (total === 0) return;
      screens.forEach(function (s) {
        s.el.style.position = 'absolute';
        s.el.style.inset = '0';
      });
      // 复用单页导航（无 topbar 页内导航，进度用总控 renderShellChrome）。
      // 键盘不放这里绑：embed 模式下 bindShellKeys 已在 document 上监听 keydown，
      // 再 bindKeys 会对同一次 ↓/↑ 触发两次 next/prev（每按一次跳两屏，
      // 播放位置与页码/章节错位 —— 2026-08-30 回归修复）。点击/滚轮/触摸无此冲突。
      bindClick();
      bindMouse();
      bindTouch();
      showScreen(0);
      activate(screens[0]);
      renderShellChrome();
    }
  }

  function initEmbed() {
    embedMode = true;
    embedPages = [];
    // 若 http 可用 fetch 则注入；file:// 下 fetch 受限 → 提示用 http
    if (location.protocol === 'file:') {
      var msg = document.createElement('div');
      msg.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font:14px var(--font-mono);color:var(--text-3);text-align:center;padding:40px;';
      msg.textContent = 'embed(JS注入)模式需要 http 访问（file:// 下 fetch 受限）。请用 http 打开总控页。';
      document.body.appendChild(msg);
      return;
    }
    // 串行加载：保证注入 DOM 顺序 = plan.pages 顺序（并发 fetch 会乱序导致故事线错位）
    var embIdx = 0;
    function nextEmb() {
      if (embIdx >= shellPlan.pages.length) { checkEmbedReady(); return; }
      embedChapter(shellPlan.pages[embIdx], embIdx, nextEmb);
      embIdx++;
    }
    nextEmb();
  }

  function loadPage(i, visible) {
    if (i < 0 || i >= shellPlan.pages.length) return;
    if (shellFrames[i]) return;              // 不重复创建；不销毁（翻回保留状态）
    var p = shellPlan.pages[i];
    var fr = document.createElement('iframe');
    fr.className = 'shell-frame';
    fr.setAttribute('data-page', String(i));
    fr.setAttribute('aria-label', p.title || ('第 ' + (i + 1) + ' 页'));
    fr.title = p.file || '';
    // 隐藏用 visibility:hidden 而非 display:none：保留布局尺寸，避免 mermaid/logic-flow
    // 在 0×0 上下文渲染产生 NaN transform；不可见也不可交互。
    fr.style.visibility = visible ? 'visible' : 'hidden';
    fr.__createdVisible = !!visible;
    fr.src = p.file;                         // 相对总控页
    var stage = document.querySelector('.shell-stage') || document.body;
    stage.appendChild(fr);
    shellFrames[i] = fr;
    fr.addEventListener('load', function () {
      postToFrame(fr, { type: 'deck-register' });   // 确认容器模式（页收到后才接管翻章）
    });
  }

  function showPage(i) {
    if (i < 0 || i >= shellPlan.pages.length) return;
    if (!shellFrames[i]) loadPage(i, true);  // 未预加载 → 直接创建并可见（加载时自然播放入场）
    shellFrames.forEach(function (f, j) {
      if (f) f.style.visibility = (j === i) ? 'visible' : 'hidden';
    });
    var first = !shellShown[i];
    shellShown[i] = true;
    shellCur = i;
    var p = shellPlan.pages[i];
    if (first && !shellFrames[i].__createdVisible) {
      // 预加载（隐藏）期间入场已悄悄放完 → 首次展示重演入场，翻页无白屏
      // 若编排定义了屏级切片 [from,to] → 下发 range 让页内从起始屏开始并在边界自动翻章
      if (typeof p.from === 'number' || typeof p.to === 'number') {
        postToFrame(shellFrames[i], { type: 'deck-cmd', cmd: 'range',
          from: (typeof p.from === 'number' ? p.from : 0),
          to: (typeof p.to === 'number' ? p.to : -1) });
      } else {
        postToFrame(shellFrames[i], { type: 'deck-cmd', cmd: 'jump', index: 0 });
      }
    }
    loadPage(i + 1, false);                  // 预加载下一页（隐藏）
    try { shellFrames[i].contentWindow.focus(); } catch (e) {}   // 键盘焦点进 iframe
    renderShellChrome();
  }

  // 有效屏数/已完成屏数（支持 plan 屏级切片 from/to）
  function effTotal(p, st) {
    var raw = p.screens || (st && st.total) || 0;
    if (!raw) return 0;
    var from = (typeof p.from === 'number') ? p.from : 0;
    var to = (typeof p.to === 'number') ? Math.min(p.to, raw - 1) : raw - 1;
    if (to < from) return 0;
    return to - from + 1;
  }
  function effDone(p, st) {
    var raw = p.screens || (st && st.total) || 0;
    if (!raw) return 0;
    var idx = st ? st.index : 0;
    var from = (typeof p.from === 'number') ? p.from : 0;
    var to = (typeof p.to === 'number') ? Math.min(p.to, raw - 1) : raw - 1;
    if (idx < from) return 0;
    return Math.min(to - from + 1, idx - from + 1);
  }

  function renderShellChrome() {
    var pages = shellPlan.pages;
    var tabs = document.querySelectorAll('.shell-tab');
    // embed 模式：注入后所有屏 flat 排列，按当前屏反推所在节高亮
    if (embedMode && embedReady) {
      var curScreen = current;
      var acc = 0, curPage = 0;
      for (var q = 0; q < pages.length; q++) {
        var cnt = (embedPages[q] && embedPages[q].count) || 0;
        if (curScreen < acc + cnt) { curPage = q; break; }
        acc += cnt;
        curPage = q + 1;
      }
      tabs.forEach(function (b, j) { b.classList.toggle('cur', j === curPage); });
      var totalE = total, doneE = Math.min(totalE, curScreen + 1);
      var bar = document.querySelector('.shell-bottom .deck-progress .bar');
      var pos = document.querySelector('.shell-pos');
      var pn = document.querySelector('.shell-pagename');
      if (bar) bar.style.width = Math.min(100, (doneE / totalE) * 100) + '%';
      if (pos) pos.textContent = (curPage + 1) + '/' + pages.length + ' 节 · ' + doneE + '/' + totalE + ' 屏';
      if (pn) pn.textContent = pages[curPage].title || '';
      scrollActiveTabIntoView();
      return;
    }
    tabs.forEach(function (b, j) { b.classList.toggle('cur', j === shellCur); });
    // 进度按「屏幕(screen)」颗粒度计算：每节=1个 iframe，内含多屏（每屏≈30s）。
    // 屏数优先级：plan.pages[i].screens（编排权威标注）> iframe 上报 total（实测量）；
    // plan.pages[i].from/to（屏级切片）只计切片内的有效屏。
    var totalScreens = 0, doneScreens = 0, loadedAny = false;
    pages.forEach(function (p, i) {
      var st = shellLast[i];
      var total = effTotal(p, st);
      if (!total) return;
      loadedAny = true;
      totalScreens += total;
      if (i < shellCur) doneScreens += total;          // 已翻完的节：全屏计入
      else if (i === shellCur) doneScreens += effDone(p, st);
    });
    var bar = document.querySelector('.shell-bottom .deck-progress .bar');
    var pos = document.querySelector('.shell-pos');
    var pn = document.querySelector('.shell-pagename');
    if (loadedAny && totalScreens > 0) {
      if (bar) bar.style.width = Math.min(100, (doneScreens / totalScreens) * 100) + '%';
      if (pos) pos.textContent = (shellCur + 1) + '/' + pages.length + ' 节 · ' + Math.min(doneScreens, totalScreens) + '/' + totalScreens + ' 屏';
    } else {
      // 完全未知 → 按节回退（首屏上报前短暂过渡）
      var done = 0;
      pages.forEach(function (p, i) {
        if (i < shellCur) { done += 1; return; }
        if (i === shellCur) {
          var st2 = shellLast[i];
          if (st2 && st2.total) done += Math.min(1, ((st2.index || 0) + 1) / st2.total);
        }
      });
      if (bar) bar.style.width = ((done / pages.length) * 100) + '%';
      if (pos) pos.textContent = (shellCur + 1) + ' / ' + pages.length + ' 页';
    }
    if (pn) pn.textContent = pages[shellCur].title || '';
    scrollActiveTabIntoView();
  }

  function broadcastTheme() {
    var t = window.HDTheme ? window.HDTheme.get() : (document.documentElement.getAttribute('data-theme') || 'dark');
    shellFrames.forEach(function (f) { if (f) postToFrame(f, { type: 'deck-cmd', cmd: 'theme', theme: t }); });
  }

  function bindShellKeys() {
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (t && t.closest && (t.closest('button') || t.closest('a'))) return;   // 焦点在按钮上交给原生
      var k = e.key;
      if (k === 'ArrowDown' || k === 's' || k === 'S' || k === 'PageDown' || k === ' ') {
        e.preventDefault(); if (embedMode && embedReady) next(); else cmdActive('next');
      } else if (k === 'ArrowUp' || k === 'w' || k === 'W' || k === 'PageUp') {
        e.preventDefault(); if (embedMode && embedReady) prev(); else cmdActive('prev');
      } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
        if (embedMode && embedReady) nextChapter(); else showPage(shellCur + 1);
      } else if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
        if (embedMode && embedReady) prevChapter(); else showPage(shellCur - 1);
      } else if (k === 'Home') {
        e.preventDefault();
        if (embedMode && embedReady) jump(0); else cmdActive('home');
      } else if (k === 'End') {
        e.preventDefault();
        if (embedMode && embedReady) jump(total - 1); else cmdActive('end');
      }
    });
  }

  /* ---------- 手机端：右下角「全屏」切换（不旋转——手机自带横屏） ---------- */
  function isMobileUA() {
    return /Android|iPhone|iPad|iPod|Mobile|Mobi|Opera Mini|IEMobile/i.test(navigator.userAgent)
      || (navigator.platform && /iPhone|iPad|iPod|Android/i.test(navigator.platform));
  }

  var fullscreenBtn = null;

  function ensureFullscreenStyle() {
    if (document.getElementById('shell-fullscreen-style')) return;
    var st = document.createElement('style');
    st.id = 'shell-fullscreen-style';
    st.textContent =
      // ============ 全屏：不旋转舞台，16:9 等比 fit 视口居中（letterbox） ============
      // 手机系统自带横屏：用户转手机即横屏。全屏模式只负责放大 + 隐藏系统 UI，
      // 舞台始终按 16:9 contain（--fs-w/--fs-h 由 JS 计算），避免拉伸变形。
      'html.shell-fullscreen .shell-stage{'
      + 'position:fixed;top:50%;left:50%;'
      + 'transform:translate(-50%,-50%);'
      + 'width:var(--fs-w,100vw);height:var(--fs-h,100vh);'
      + 'background:var(--bg-0);'
      + 'box-shadow:0 0 0 2000px var(--bg-0);}'
      // 顶栏/底栏：全屏时保持可用，收窄/半透明，不遮挡内容
      + 'html.shell-fullscreen .shell-topbar{'
      + 'opacity:.9;}'
      + 'html.shell-fullscreen .shell-bottom{'
      + 'opacity:.9;}'
      // 常规右下角全屏按钮
      + '.shell-fs-btn{position:fixed;right:14px;bottom:56px;z-index:80;'
      + 'pointer-events:auto;cursor:pointer;'
      + 'font:600 12px var(--font-mono);color:var(--text-3);'
      + 'background:var(--glass-bg);border:1px solid var(--border-subtle);'
      + 'border-radius:var(--radius-pill);padding:5px 12px;'
      + 'backdrop-filter:blur(var(--glass-blur));opacity:.82;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.18);}'
      + '.shell-fs-btn:active{opacity:1;}'
      // 窄屏折叠导航：汉堡按钮 + 下拉面板
      + '.shell-collapsed .deck-tabs{'
      + 'position:fixed;top:52px;left:12px;right:12px;'
      + 'flex-direction:column;align-items:stretch;gap:4px;'
      + 'background:var(--bg-1);border:1px solid var(--border-subtle);'
      + 'border-radius:var(--radius-md);padding:8px;'
      + 'display:none;max-height:62vh;overflow-y:auto;'
      + 'box-shadow:0 8px 28px rgba(0,0,0,.35);z-index:60;}'
      + '.shell-collapsed .deck-tab{width:100%;text-align:left;padding:8px 12px;border-radius:var(--radius-sm);}'
      + '.shell-collapsed.shell-open .deck-tabs{display:flex;}'
      + '.shell-burger{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;'
      + 'width:34px;height:30px;padding:0;margin-right:4px;flex-shrink:0;'
      + 'color:var(--text-3);border:1px solid var(--border-subtle);'
      + 'border-radius:var(--radius-pill);background:var(--glass-bg);cursor:pointer;}'
      + '.shell-burger:hover{color:var(--brand-1);border-color:var(--border-strong);}';
    document.head.appendChild(st);
  }

  function applyFullscreenSize() {
    // 舞台 16:9 contain 于视口（不旋转）：宽高按视口 fit，letterbox 留黑边
    var vw = window.innerWidth, vh = window.innerHeight;
    var w, h;
    if (vw / vh > 16 / 9) { h = vh; w = h * 16 / 9; }
    else { w = vw; h = w * 9 / 16; }
    var el = document.documentElement;
    el.style.setProperty('--fs-w', Math.round(w) + 'px');
    el.style.setProperty('--fs-h', Math.round(h) + 'px');
  }

  function toggleFullscreen() {
    var el = document.documentElement;
    var inFs = el.classList.contains('shell-fullscreen');
    if (!inFs) {
      applyFullscreenSize();
      el.classList.add('shell-fullscreen');
      var fs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
      if (fs) { try { fs.call(el); } catch (e) {} }
      if (fullscreenBtn) fullscreenBtn.textContent = '退出全屏';
    } else {
      el.classList.remove('shell-fullscreen');
      var ex = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (ex && (document.fullscreenElement || document.webkitFullscreenElement)) {
        try { ex.call(document); } catch (e) {}
      }
      if (fullscreenBtn) fullscreenBtn.textContent = '全屏';
    }
  }

  function buildFullscreenBtn() {
    if (fullscreenBtn) return;
    ensureFullscreenStyle();
    var b = document.createElement('button');
    b.className = 'shell-fs-btn';
    b.type = 'button';
    b.textContent = '全屏';
    b.title = '切换全屏（手机端）';
    b.addEventListener('click', toggleFullscreen);
    document.body.appendChild(b);
    fullscreenBtn = b;
    // 全屏状态变化时同步按钮文案（浏览器返回键退出全屏等）
    document.addEventListener('fullscreenchange', syncFullscreenBtn);
    document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);
    // 尺寸变化时重算 16:9（转屏、全屏高度变化）
    window.addEventListener('resize', function () {
      if (document.documentElement.classList.contains('shell-fullscreen')) applyFullscreenSize();
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () {
        if (document.documentElement.classList.contains('shell-fullscreen')) applyFullscreenSize();
      }, 300);
    });
  }

  function syncFullscreenBtn() {
    if (!fullscreenBtn) return;
    var inFs = !!(
      document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement
    );
    fullscreenBtn.textContent = inFs ? '退出全屏' : '全屏';
  }

  function cmdActive(cmd) {
    var f = shellFrames[shellCur];
    if (f) postToFrame(f, { type: 'deck-cmd', cmd: cmd });
  }

  /* 总控侧：接收页面上报 */
  function onShellMsg(e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    var idx = -1;                              // e.source 是 iframe 的 window，需与 contentWindow 比对
    for (var k = 0; k < shellFrames.length; k++) {
      if (shellFrames[k] && shellFrames[k].contentWindow === e.source) { idx = k; break; }
    }
    if (idx < 0) return;                       // 只认自己管理的 iframe
    if (d.type === 'deck-progress') {
      shellLast[idx] = { index: d.index, total: d.total, state: d.state };
      if (idx === shellCur) renderShellChrome();
    } else if (d.type === 'deck-go') {
      // 页内翻章（或最后一屏 ↓）：按 plan 顺序切页，忽略页内 deck-config 的文件跳转
      showPage(idx + (d.dir >= 0 ? 1 : -1));
    }
  }

  /* 页侧：接收总控指令（总控页自身也挂此监听，靠 source 过滤互不干扰） */
  function onPageMessage(e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (e.source !== window.parent) return;    // 只接受父窗口指令
    if (d.type === 'deck-register') {
      shellMode = true;                        // 父窗口确认为总控容器
      if (pendingGo) { postShell(pendingGo); pendingGo = null; }
      return;
    }
    if (d.type !== 'deck-cmd') return;
    if (d.cmd === 'next') next();
    else if (d.cmd === 'prev') prev();
    else if (d.cmd === 'jump') { if (typeof d.index === 'number') jump(d.index); }
    else if (d.cmd === 'home') jump(0);
    else if (d.cmd === 'end') jump(total - 1);
    else if (d.cmd === 'range') {
      // 屏级切片：总控下发 [from,to]（0-based），页内翻屏被钳制在该范围，两端自动翻章
      shellFrom = (typeof d.from === 'number') ? d.from : 0;
      shellTo = (typeof d.to === 'number') ? d.to : -1;
      jump(shellFrom);
    }
    else if (d.cmd === 'theme') { if (window.HDTheme && d.theme) window.HDTheme.set(d.theme); }
  }

  /* 字体/logo 加载后 tab 宽度变化，窗口 load 时校正一次居中（直接打开深层页的场景） */
  window.addEventListener('load', function () { scrollActiveTabIntoView(); });

  window.deck = {
    init: init,
    next: next,
    prev: prev,
    jump: jump,
    nextChapter: nextChapter,
    prevChapter: prevChapter,
    goFile: goFile,
    // 总控容器模式
    showPage: showPage,
    loadPage: loadPage
  };
})();
