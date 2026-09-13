/* ============================================================
 * lib/components/logic-flow.js · 逻辑图组件（mermaid 封装）
 *
 * 契约：一行标签 + 一段 JSON，file:// 可用，零 fetch 零 module。
 *   <logic-flow data-json='{ "dir":"LR", "nodes":[...], "edges":[...] }'>
 *   <logic-flow data-mermaid='flowchart LR ...'>（进阶：直接写 mermaid 原文）
 *
 * 节点 cls 可选值：warn（红）/ ok（绿）/ brand（金）/ sub（紫）/ plain（灰）
 * 颜色全部读取 tokens.css 的 var(--...)（getComputedStyle），不硬编码，
 * 因此暗/浅主题切换自动生效（MutationObserver 监听 html[data-theme] 重绘）。
 * mermaid 需先于本脚本加载（lib/vendor/mermaid/mermaid.min.js）；缺失时降级显示原文。
 * ============================================================ */
(function () {
  if (window.customElements && customElements.get('logic-flow')) return;

  function cssVar(name) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || '#888888';
  }

  /* 两个 hex 色按比例混合（mermaid classDef 不支持 rgba 小数 alpha，用实体 hex 表达 tint） */
  function mix(hex1, hex2, r) {
    function p(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }
    function toHex(n) { var s = Math.round(n).toString(16); return s.length === 1 ? '0' + s : s; }
    var a = p(hex1), b = p(hex2);
    return '#' + a.map(function (c, i) { return toHex(c * (1 - r) + b[i] * r); }).join('');
  }

  function esc(s) {
    return String(s).replace(/"/g, '&quot;').replace(/\n/g, '<br/>');
  }

  /* 结构化 JSON → mermaid flowchart 文本 */
  function buildMermaid(json) {
    var dir = json.dir || 'LR';
    var lines = ['flowchart ' + dir];
    (json.nodes || []).forEach(function (n) {
      var cls = n.cls ? ':::' + n.cls : '';
      lines.push('  ' + n.id + '["' + esc(n.label) + '"]' + cls);
    });
    (json.edges || []).forEach(function (e) {
      var label = e.label ? '|"' + esc(e.label) + '"|' : '';
      var arr = e.dotted ? '-.->' : '-->';
      lines.push('  ' + e.from + ' ' + arr + label + ' ' + e.to);
    });
    return lines.join('\n');
  }

  function readTokens() {
    return {
      bg0: cssVar('--bg-0'), bg1: cssVar('--bg-1'), bg2: cssVar('--bg-2'), bg3: cssVar('--bg-3'),
      text1: cssVar('--text-1'), text2: cssVar('--text-2'), text3: cssVar('--text-3'),
      brand1: cssVar('--brand-1'), brand2: cssVar('--brand-2'), brand3: cssVar('--brand-3'),
      ok: cssVar('--brand-ok'), border: cssVar('--border-subtle'),
      fontBody: cssVar('--font-body'), fontMono: cssVar('--font-mono')
    };
  }

  function initMermaid(t) {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'loose',
      htmlLabels: true,
      flowchart: { curve: 'basis', padding: 14, nodeSpacing: 40, rankSpacing: 52, useMaxWidth: true },
      themeVariables: {
        background: t.bg0,
        primaryColor: t.bg2,
        primaryTextColor: t.text1,
        primaryBorderColor: t.brand1,
        secondaryColor: t.bg1,
        secondaryTextColor: t.text2,
        secondaryBorderColor: t.brand2,
        tertiaryColor: t.bg3,
        tertiaryTextColor: t.text2,
        tertiaryBorderColor: t.brand3,
        lineColor: t.brand1,
        textColor: t.text2,
        edgeLabelBackground: t.bg2,
        fontFamily: t.fontBody,
        fontSize: '15px',
        clusterBkg: t.bg1,
        clusterBorder: t.border
      }
    });
  }

  function classDefs(t) {
    return [
      'classDef warn fill:' + mix(t.brand3, t.bg2, .88) + ',stroke:' + t.brand3 + ',color:' + t.text1 + ',stroke-width:1.5px',
      'classDef ok fill:' + mix(t.ok, t.bg2, .88) + ',stroke:' + t.ok + ',color:' + t.text1 + ',stroke-width:1.5px',
      'classDef brand fill:' + mix(t.brand1, t.bg2, .86) + ',stroke:' + t.brand1 + ',color:' + t.text1 + ',stroke-width:1.5px',
      'classDef sub fill:' + mix(t.brand2, t.bg2, .88) + ',stroke:' + t.brand2 + ',color:' + t.text1 + ',stroke-width:1.5px',
      'classDef plain fill:' + t.bg2 + ',stroke:' + t.text3 + ',color:' + t.text2 + ',stroke-width:1px'
    ].join('\n');
  }

  /* 读取组件可用的纵向高度预算（CSS 变量 --lf-max-h，支持 px/vh/%），默认 54vh。
   * 防止 TB 方向逻辑图按宽等比后高度超过 .s-wrap 剩余空间，被 .screen{overflow:hidden} 裁掉。 */
  function parseMaxH(el) {
    var v = getComputedStyle(el).getPropertyValue('--lf-max-h').trim() || '54vh';
    var m = v.match(/^([\d.]+)\s*(px|vh|%)$/);
    if (!m) return 0.54 * window.innerHeight;
    var n = parseFloat(m[1]);
    if (m[2] === 'vh') return n / 100 * window.innerHeight;
    if (m[2] === '%') return n / 100 * (el.clientHeight || window.innerHeight);
    return n;
  }

  /* 按 viewBox 等比缩放 svg，同时满足容器宽与纵向预算（只缩不放） */
  function fitSvg(svg) {
    var vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !vb.width || !vb.height) return;
    var wrap = svg.parentElement;
    var maxW = wrap.clientWidth || 600;
    var maxH = parseMaxH(wrap);
    var scale = Math.min(maxW / vb.width, maxH / vb.height);
    if (scale > 1) scale = 1;                        // 只缩不放
    svg.style.width = Math.round(vb.width * scale) + 'px';
    svg.style.height = Math.round(vb.height * scale) + 'px';
    svg.style.maxWidth = '100%';
    svg.style.maxHeight = maxH + 'px';               // 兜底：CSS 也约束
    svg.style.margin = '0 auto';
  }

  class LogicFlow extends HTMLElement {
    connectedCallback() {
      this._box = null;
      this._timer = null;
      this._observer = new MutationObserver(function () { this._schedule(); }.bind(this));
      this._observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      this._fitHandler = function () { this._schedule(); }.bind(this);
      window.addEventListener('resize', this._fitHandler);
      this._schedule();
    }
    disconnectedCallback() {
      if (this._observer) this._observer.disconnect();
      if (this._timer) clearTimeout(this._timer);
      if (this._fitHandler) window.removeEventListener('resize', this._fitHandler);
    }
    _schedule() {
      // 主题切换防抖：等 mermaid 就绪
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(function () { this._render(); }.bind(this), 30);
    }
    _text() {
      var raw = this.getAttribute('data-mermaid');
      if (raw) return raw;
      try { return buildMermaid(JSON.parse(this.getAttribute('data-json') || '{}')); }
      catch (e) { return null; }
    }
    _render() {
      var text = this._text();
      if (!this._box) {
        this._box = document.createElement('div');
        this._box.className = 'logic-flow';
        this.innerHTML = '';
        this.appendChild(this._box);
      }
      var target = this._box;
      if (!window.mermaid || !text) {
        target.innerHTML = '<pre class="lf-degraded">' + (text || this.getAttribute('data-json') || '') + '</pre>';
        return;
      }
      initMermaid(readTokens());
      target.innerHTML = '';
      var full = text + '\n' + classDefs(readTokens());
      window.mermaid.render('lf_' + Date.now().toString(36), full).then(function (res) {
        target.innerHTML = res.svg;
        var svg = target.querySelector('svg');
        if (svg) fitSvg(svg);
        this.dispatchEvent(new CustomEvent('logicflow-rendered', { detail: { ok: true } }));
      }.bind(this)).catch(function (e) {
        target.innerHTML = '<pre class="lf-error">逻辑图渲染失败：' + e.message + '</pre>';
        this.dispatchEvent(new CustomEvent('logicflow-rendered', { detail: { ok: false } }));
      }.bind(this));
    }
  }

  customElements.define('logic-flow', LogicFlow);
})();
