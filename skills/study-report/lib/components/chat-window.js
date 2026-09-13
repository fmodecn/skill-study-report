/* ============================================================
 * lib/components/chat-window.js · 仿微信一对一聊天窗
 * 用法：
 *   <link rel="stylesheet" href=".../lib/components/chat-window.css">
 *   <chat-window data-chat='{...}'></chat-window>          // 短数据
 *   <script type="application/json" id="chat-x"> {...} </script>
 *   <chat-window data-ref="#chat-x"></chat-window>         // 长数据
 * 消息类型：text / transfer(转账卡) / time(时间) / divider(分隔) / image / quote
 * 全部颜色来自 tokens.css 的 --chat-*（双主题自适应）。
 * ============================================================ */
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function nl(s) {
    return esc(s).replace(/\n/g, '<br>');
  }

  function parse(el) {
    if (el.dataset.chat) { try { return JSON.parse(el.dataset.chat); } catch (e) { return null; } }
    if (el.dataset.ref) {
      var src = document.querySelector(el.dataset.ref);
      if (src) { try { return JSON.parse(src.textContent); } catch (e) { return null; } }
    }
    return null;
  }

  function renderMsg(m) {
    var side = m.side === 'out' ? 'out' : 'in';
    if (m.type === 'time') {
      return '<div class="cw-time">' + esc(m.text) + '</div>';
    }
    if (m.type === 'divider') {
      return '<div class="cw-divider">' + esc(m.text) + '</div>';
    }
    // 带气泡的消息
    var ava = '<div class="cw-ava">' + esc(m.avatar || (side === 'out' ? '我' : '')) + '</div>';
    var inner = '';
    if (m.type === 'transfer') {
      inner = '<div class="cw-bub cw-bub-transfer">'
        + '<span class="cw-tf-label">' + esc(m.text || '微信转账') + '</span>'
        + '<span class="cw-tf-amt">' + esc(m.amount || '') + '</span>'
        + '</div>';
    } else if (m.type === 'image') {
      inner = '<div class="cw-bub"><img class="cw-img" src="' + esc(m.src) + '" alt="">'
        + (m.caption ? '<div class="cw-cap">' + esc(m.caption) + '</div>' : '')
        + '</div>';
    } else if (m.type === 'quote') {
      inner = '<div class="cw-bub cw-bub-quote">' + nl(m.text)
        + (m.source ? '<div class="cw-q-src">' + esc(m.source) + '</div>' : '')
        + '</div>';
    } else {
      var body = nl(m.text);
      if (m.bold) body = '<b>' + body + '</b>';
      inner = '<div class="cw-bub">' + body + '</div>';
    }
    return '<div class="cw-msg ' + side + '">' + (side === 'in' ? ava + inner : inner + ava) + '</div>';
  }

  function render(el, d) {
    if (!d) { el.innerHTML = '<div class="cw cw-empty">数据缺失</div>'; return; }
    var msgs = (d.msgs || []).map(renderMsg).join('');
    el.innerHTML =
      '<div class="cw">' +
        (d.title || d.subtitle ? (
          '<div class="cw-bar">' + esc(d.title || '') +
            (d.subtitle ? '<span class="cw-sub">' + esc(d.subtitle) + '</span>' : '') +
          '</div>'
        ) : '') +
        '<div class="cw-body">' + msgs + '</div>' +
        (d.footer ? '<div class="cw-foot">' + esc(d.footer) + '</div>' : '') +
      '</div>';
  }

  var ChatWindow = function () {
    return Reflect.construct(HTMLElement, [], ChatWindow);
  };
  ChatWindow.prototype = Object.create(HTMLElement.prototype);
  ChatWindow.prototype.constructor = ChatWindow;
  ChatWindow.prototype.connectedCallback = function () {
    var self = this;
    var d = parse(this);
    if (!d && this.dataset.ref) {
      // ref 指向的 JSON 可能晚于组件加载，延时再读一次
      setTimeout(function () { render(self, parse(self)); }, 0);
    } else {
      render(this, d);
    }
  };

  if (!customElements.get('chat-window')) {
    customElements.define('chat-window', ChatWindow);
  }
})();
