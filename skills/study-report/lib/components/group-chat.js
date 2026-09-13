/* ============================================================
 * lib/components/group-chat.js · 仿企业微信电脑端群聊窗
 * 用法：
 *   <link rel="stylesheet" href=".../lib/components/group-chat.css">
 *   <group-chat data-chat='{...}'></group-chat>
 * JSON：{ group, subtitle, members:[{name,avatar,role}],
 *         msgs:[{name,avatar,type:'text'|'card', text, at:[names], title, sub, tag}], footer }
 * 消息文本内 @成员名 自动高亮为提及标签。
 * 颜色全部来自 tokens.css 的 --chat-* / --brand-*（双主题自适应）。
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

  // 把文本里的 @成员名 渲染成高亮提及
  function mention(text, members) {
    var s = esc(text);
    members.forEach(function (m) {
      var name = esc(m.name);
      if (!name) return;
      var re = new RegExp('(@' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![^<]*>)', 'g');
      s = s.replace(re, '<span class="gc-at">$1</span>');
    });
    return s;
  }

  function renderMsg(m, members) {
    var text = '';
    if (m.type === 'card') {
      text = '<div class="gc-card">'
        + (m.title ? '<div class="gc-card-t">' + esc(m.title) + '</div>' : '')
        + (m.sub ? '<div class="gc-card-s">' + esc(m.sub) + '</div>' : '')
        + (m.tag ? '<div class="gc-card-g">' + esc(m.tag) + '</div>' : '')
        + '</div>';
    } else {
      text = '<div class="gc-text">' + mention(m.text, members) + '</div>';
    }
    return '<div class="gc-msg">'
      + '<span class="gc-ava">' + esc(m.avatar || (m.name || '?').slice(0, 1)) + '</span>'
      + '<div class="gc-box">'
      +   '<div class="gc-name">' + esc(m.name || '') + '</div>'
      +   text
      + '</div>'
      + '</div>';
  }

  function render(el, d) {
    if (!d) { el.innerHTML = '<div class="gc gc-empty">数据缺失</div>'; return; }
    var members = d.members || [];
    var memHTML = members.map(function (m) {
      return '<div class="gc-mem">'
        + '<span class="gc-ava">' + esc(m.avatar || (m.name || '?').slice(0, 1)) + '</span>'
        + '<div class="gc-mem-info">'
        +   '<div class="gc-mem-name">' + esc(m.name || '') + '</div>'
        +   (m.role ? '<div class="gc-mem-role">' + esc(m.role) + '</div>' : '')
        + '</div>'
        + '</div>';
    }).join('');
    var msgs = (d.msgs || []).map(function (m) { return renderMsg(m, members); }).join('');
    el.innerHTML =
      '<div class="gc">' +
        '<div class="gc-bar">' + esc(d.group || '') +
          (d.subtitle ? '<span class="gc-sub">' + esc(d.subtitle) + '</span>' : '') +
        '</div>' +
        '<div class="gc-main">' +
          '<div class="gc-members">' + memHTML + '</div>' +
          '<div class="gc-msgs">' + msgs + '</div>' +
        '</div>' +
        (d.footer ? '<div class="gc-foot">' + esc(d.footer) + '</div>' : '') +
      '</div>';
  }

  var GroupChat = function () {
    return Reflect.construct(HTMLElement, [], GroupChat);
  };
  GroupChat.prototype = Object.create(HTMLElement.prototype);
  GroupChat.prototype.constructor = GroupChat;
  GroupChat.prototype.connectedCallback = function () {
    var self = this;
    var d = parse(this);
    if (!d && this.dataset.ref) {
      setTimeout(function () { render(self, parse(self)); }, 0);
    } else {
      render(this, d);
    }
  };

  if (!customElements.get('group-chat')) {
    customElements.define('group-chat', GroupChat);
  }
})();
