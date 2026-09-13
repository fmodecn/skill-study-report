/* ============================================================
 * lib/player/canvas-scale.js · 画布等比缩放（固定 1280×720 画布）
 * ------------------------------------------------------------
 * 问题：demo 页内部用 vw/vh，iframe/窗口尺寸一变（手机横屏 926×428、
 *       16:10 等），版式随视口重排，与电脑 16:9 观感不一致。
 * 方案：固定 1280×720 画布，JS 按 min(innerW/1280, innerH/720) 等比
 *       scale 并居中（letterbox）。任何视口下版式与 1280×720 完全一致，
 *       只整体缩放；16:10 / 手机横竖屏自动适配，无需特判。
 * 关键一步（画布内 vw/vh 全量归零）：初始化时把本页样式表（含
 *   tokens/base/style.css 与页内 <style>）和行内 style 里的
 *   vw/vh/dvh 按 1280×720 等效换算成 px（1vw=12.8px，1vh=7.2px），
 *   并删除全部 @media 规则（画布恒 1280 宽，窄屏规则永不生效）。
 *   此后版式与窗口彻底解耦，缩放只由 transform 完成。
 * 两种模式（自动检测）：
 *   A. 包裹模式（普通 demo 页）：body 现有内容包进 .cv-stage 缩放。
 *   B. shell 模式（总控页，含 .shell-stage）：直接把 .shell-stage 当画布
 *      （1280×720 + scale），嵌入的 section / iframe 全部随之缩放；
 *      !important 压过 deck.js 全屏 letterbox 的 width/height 声明，
 *      全屏仅负责隐藏系统 UI，缩放始终由本脚本负责。
 * 规则（见 .claude/rules/page-craft.md「画布等比缩放规范」）：
 *   - 新页面禁止再写 vw/vh 与窄屏 @media；画布内 1vw=12.8px、1vh=7.2px。
 * 用法：demo 页在 deck.js 之前引一次；shell 页在 deck.init() 之后引一次。
 *   <script src="../../../../../../lib/player/canvas-scale.js"></script>
 * 纪律：只用 var(--...)，不新增色值；file:// 直接可用；零依赖；幂等。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__CANVAS_SCALE__) return;   // 幂等
  window.__CANVAS_SCALE__ = true;

  var W = 1280, H = 720, PXW = 12.8, PXH = 7.2;
  var VW_RE = /(\d*\.?\d+)(d?v[hw])\b/g;

  /* Nvw/Nvh/Ndvh → 1280×720 画布等效 px（1vw=12.8px，1vh=7.2px） */
  function pxify(text) {
    return text.replace(VW_RE, function (m, num, unit) {
      var n = parseFloat(num);
      if (unit === 'vw') return round1(n * PXW) + 'px';
      return round1(n * PXH) + 'px';           // vh / dvh 都按画布高
    });
  }
  function round1(n) { return Math.round(n * 10) / 10; }
  function hasViewportUnit(text) { return /\d[ \t]*d?v[hw]\b/.test(text); }

  /* 样式表改写：vw/vh→px；@media 整条删除（画布恒 1280 宽）。
     仅处理同源样式表（本仓库全部本地），跨域/解析失败静默跳过。 */
  function rewriteSheet(sheet) {
    if (!sheet) return;
    if (sheet.ownerNode && sheet.ownerNode.id === 'cv-scale-style') return; // 跳过本脚本注入的样式
    var rules;
    try { rules = sheet.cssRules; } catch (e) { return; }
    if (!rules) return;
    rewriteRuleList(rules);
  }
  function rewriteRuleList(list) {
    Array.prototype.forEach.call(list, function (rule) {
      var type = rule.type;
      if (type === 4 /* CSSMediaRule */ || type === 12 /* CSSSupportsRule */) {
        deleteRule(list, rule);              // @media/@supports 整条移除
        return;
      }
      if ((type === 1 /* CSSStyleRule */ || type === 5 /* CSSFontFaceRule */) &&
          hasViewportUnit(rule.cssText)) {
        var css = pxify(rule.cssText);
        try { rule.style.cssText = css.slice(css.indexOf('{') + 1, css.lastIndexOf('}')); }
        catch (e) { /* 保底：无法就地改则跳过 */ }
      }
    });
  }
  function deleteRule(list, rule) {
    try {
      var idx = Array.prototype.indexOf.call(list, rule);
      if (idx >= 0 && list.deleteRule) list.deleteRule(idx);
    } catch (e) { /* 忽略 */ }
  }
  /* 行内 style：clamp(...vw...) 等直接写在 style 属性上，样式表改写覆盖不到 */
  function rewriteInlineStyles(doc) {
    var els = doc.querySelectorAll('[style]');
    Array.prototype.forEach.call(els, function (el) {
      var s = el.getAttribute('style');
      if (s && hasViewportUnit(s)) el.setAttribute('style', pxify(s));
    });
  }

  var CSS_TEXT =
    /* 画布页高度基准：--screen-h 由「视口高」改为「画布高」（仅本页覆盖，不动 tokens.css） */
    'html.cv-fit { --screen-h: 720px; }\n' +
    'html.cv-fit, html.cv-fit body { width:100%; height:100%; margin:0; padding:0; overflow:hidden; background:var(--bg-0); }\n' +
    /* 包裹模式：画布舞台固定 1280×720，transform-origin 左上，JS scale + 居中 */
    'html.cv-fit .cv-stage {\n' +
    '  position: fixed; left: 0; top: 0;\n' +
    '  width: 1280px; height: 720px;\n' +
    '  transform-origin: 0 0;\n' +
    '  background: var(--bg-0);\n' +
    '  overflow: hidden;\n' +
    '}\n' +
    /* shell 模式：.shell-stage 本身即画布（!important 压过 deck.js 全屏规则，
       全屏时 deck 只隐藏系统 UI；top/left 由 fit() 内联控制，优先级更高） */
    'html.cv-fit .shell-stage {\n' +
    '  width: 1280px !important; height: 720px !important;\n' +
    '  transform-origin: 0 0 !important;\n' +
    '  overflow: hidden;\n' +
    '}\n' +
    /* 兜底：base.css 的 .screen 宽高已由 vw/vh 归零改写，这里再锚一次 */
    'html.cv-fit .screen { width: 1280px; }\n' +
    /* 页内 style.css 的 100vh 高度基准已归零，这里再锚一次 */
    'html.cv-fit .page  { height: 720px; }\n' +
    'html.cv-fit .screen{ min-height: 720px; }\n' +
    'html.cv-fit .cover { min-height: 720px; }\n';

  function makeFit(el) {
    return function fit() {
      var s = Math.min(window.innerWidth / W, window.innerHeight / H);
      if (!isFinite(s) || s <= 0) s = 1;
      el.style.transform = 'scale(' + s + ')';
      el.style.left = Math.round((window.innerWidth - W * s) / 2) + 'px';
      el.style.top = Math.round((window.innerHeight - H * s) / 2) + 'px';
      document.documentElement.style.setProperty('--cv-scale', String(Math.round(s * 1000) / 1000));
    };
  }

  function init() {
    var docEl = document.documentElement;
    if (docEl.classList.contains('cv-fit')) return;      // 已初始化
    var body = document.body;
    if (!body) { document.addEventListener('DOMContentLoaded', init, { once: true }); return; }

    docEl.classList.add('cv-fit');

    // 1) 画布内 vw/vh 全量归零（样式表 + 行内 style），@media 删除
    Array.prototype.forEach.call(document.styleSheets, rewriteSheet);
    rewriteInlineStyles(document);

    // 2) 注入画布样式（在改写之后，自身不受 pxify 影响）
    var st = document.createElement('style');
    st.id = 'cv-scale-style';
    st.textContent = CSS_TEXT;
    document.head.appendChild(st);

    // 3) shell 模式：.shell-stage 即画布（shell chrome 在画布外，保持原生尺寸）
    var shellStage = body.querySelector('.shell-stage');
    if (shellStage) {
      var fitShell = makeFit(shellStage);
      window.addEventListener('resize', fitShell, { passive: true });
      window.addEventListener('orientationchange', fitShell);
      fitShell();
      // shell embed 模式：deck.init() 异步把 demo 屏克隆进 .shell-stage，
      // 屏内行内 style 携带 vw/vh → 到达后重写一遍（幂等）
      var moTimer = null;
      var mo = new MutationObserver(function () {
        clearTimeout(moTimer);
        moTimer = setTimeout(function () {
          Array.prototype.forEach.call(document.styleSheets, rewriteSheet);
          rewriteInlineStyles(document);
          fitShell();
        }, 80);
      });
      mo.observe(shellStage, { childList: true, subtree: true });
      return;
    }

    // 4) 包裹模式：body 现有全部子节点移入 .cv-stage（保留顺序与事件绑定）
    var stage = document.createElement('div');
    stage.className = 'cv-stage';
    stage.id = 'cv-stage';
    var moving = Array.prototype.slice.call(body.childNodes);
    for (var i = 0; i < moving.length; i++) stage.appendChild(moving[i]);
    body.appendChild(stage);

    var fit = makeFit(stage);
    window.addEventListener('resize', fit, { passive: true });
    window.addEventListener('orientationchange', fit);
    fit();
  }

  // 同步脚本：body 已在 DOM 即刻执行；未就绪则等 DOMContentLoaded
  if (document.readyState === 'loading' && !document.body) {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
