/* Widget chat khách hàng — Thịnh Thế Vinh Hoa. Tự chèn UI + xử lý. */
(function () {
  var SID = localStorage.getItem('ttvh_sid');
  if (!SID) { SID = 'web_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('ttvh_sid', SID); }
  var lastTs = 0, pollTimer = null, greeted = false, zaloLink = '', sending = false;

  var css = ''
    + '.ttvh-fab{position:fixed;right:22px;bottom:22px;z-index:9998;width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;'
    + 'background:linear-gradient(135deg,#2f86 f0,#155fc4);color:#fff;font-size:26px;box-shadow:0 14px 34px -10px rgba(21,95,196,.6);transition:transform .2s;display:grid;place-items:center}'
    + '.ttvh-fab:hover{transform:scale(1.08)}'
    + '.ttvh-fab .dot{position:absolute;top:9px;right:11px;width:12px;height:12px;border-radius:50%;background:#37d67a;border:2px solid #fff}'
    + '.ttvh-win{position:fixed;right:22px;bottom:94px;z-index:9999;width:380px;max-width:calc(100vw - 28px);height:560px;max-height:calc(100vh - 130px);'
    + 'background:#fff;border-radius:20px;box-shadow:0 30px 70px -18px rgba(15,40,80,.45);display:none;flex-direction:column;overflow:hidden;font-family:inherit}'
    + '.ttvh-win.open{display:flex}'
    + '.ttvh-hd{background:linear-gradient(135deg,#2f86f0,#155fc4);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:11px}'
    + '.ttvh-hd .av{width:42px;height:42px;border-radius:50%;background:#fff;overflow:hidden;display:grid;place-items:center;flex:none}'
    + '.ttvh-hd .av img{width:100%;height:100%;object-fit:cover}'
    + '.ttvh-hd .ti{flex:1;min-width:0}.ttvh-hd b{font-size:15px;display:block;line-height:1.2}'
    + '.ttvh-hd .stt{font-size:12px;opacity:.95;display:flex;align-items:center;gap:6px;margin-top:2px}'
    + '.ttvh-hd .stt .d{width:8px;height:8px;border-radius:50%;background:#37d67a}'
    + '.ttvh-hd .ic{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;opacity:.95;padding:2px 4px}'
    + '.ttvh-body{flex:1;overflow-y:auto;padding:16px;background:#f4f7fb;display:flex;flex-direction:column;gap:10px}'
    + '.ttvh-row{display:flex;max-width:84%}.ttvh-row.u{align-self:flex-end}.ttvh-row.b,.ttvh-row.a{align-self:flex-start}'
    + '.ttvh-bub{padding:11px 14px;border-radius:16px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;box-shadow:0 2px 8px -4px rgba(20,50,90,.25)}'
    + '.ttvh-row.u .ttvh-bub{background:linear-gradient(135deg,#2f86f0,#155fc4);color:#fff;border-bottom-right-radius:5px}'
    + '.ttvh-row.b .ttvh-bub{background:#fff;color:#1c2b3a;border-bottom-left-radius:5px}'
    + '.ttvh-row.a .ttvh-bub{background:#eaf3ff;color:#143a5e;border:1px solid #cfe3ff;border-bottom-left-radius:5px}'
    + '.ttvh-typing{align-self:flex-start;display:none;align-items:center;gap:8px;color:#5b6b7e;font-size:13px;padding:2px 4px}'
    + '.ttvh-typing.show{display:flex}'
    + '.ttvh-typing .d{width:7px;height:7px;border-radius:50%;background:#155fc4;animation:ttvhb 1s infinite}'
    + '.ttvh-typing .d:nth-child(2){animation-delay:.15s}.ttvh-typing .d:nth-child(3){animation-delay:.3s}'
    + '@keyframes ttvhb{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}'
    + '.ttvh-ft{padding:12px 12px 8px;border-top:1px solid #e7edf4;background:#fff}'
    + '.ttvh-inp{display:flex;gap:8px;align-items:center}'
    + '.ttvh-inp input{flex:1;border:1px solid #d4def0;border-radius:22px;padding:11px 16px;font-family:inherit;font-size:14px;outline:none}'
    + '.ttvh-inp input:focus{border-color:#2f86f0}'
    + '.ttvh-inp button{border:none;background:linear-gradient(135deg,#2f86f0,#155fc4);color:#fff;border-radius:50%;width:42px;height:42px;font-size:17px;cursor:pointer;flex:none}'
    + '.ttvh-inp button:disabled{opacity:.5;cursor:default}'
    + '.ttvh-zalo{text-align:center;margin-top:8px}.ttvh-zalo a{color:#155fc4;font-size:13px;font-weight:600;text-decoration:none}.ttvh-zalo a:hover{text-decoration:underline}'
    + '.ttvh-set{position:absolute;top:62px;right:14px;background:#fff;border:1px solid #e2e8f2;border-radius:12px;box-shadow:0 14px 30px -10px rgba(20,50,90,.3);padding:12px;width:210px;display:none;z-index:5}'
    + '.ttvh-set.show{display:block}.ttvh-set label{font-size:12px;color:#5b6b7e;font-weight:600}'
    + '.ttvh-set input{width:100%;border:1px solid #d4def0;border-radius:8px;padding:8px 10px;margin:5px 0 9px;font-family:inherit;font-size:13px}'
    + '.ttvh-set button{width:100%;border:1px solid #e2e8f2;background:#f4f7fb;border-radius:8px;padding:8px;font-size:13px;cursor:pointer;font-family:inherit}';
  var st = document.createElement('style'); st.textContent = css.replace('#2f86 f0', '#2f86f0'); document.head.appendChild(st);

  var fab = document.createElement('button');
  fab.className = 'ttvh-fab'; fab.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 3C7 3 3 6.5 3 11c0 2.3 1.1 4.3 2.8 5.7L5 21l4.6-2.1c.8.2 1.6.3 2.4.3 5 0 9-3.5 9-8s-4-8-9-8Z" fill="#fff"/></svg><span class="dot"></span>';
  fab.title = 'Chat tư vấn tuyển dụng';
  var win = document.createElement('div'); win.className = 'ttvh-win';
  win.innerHTML =
    '<div class="ttvh-hd"><div class="av"><img src="images/logo-ttvh.jpg" alt="TTVH"/></div>'
    + '<div class="ti"><b>Trợ lý Thịnh Thế Vinh Hoa</b><span class="stt"><span class="d" id="ttvhDot"></span><span id="ttvhStt">Tự động trả lời</span></span></div>'
    + '<button class="ic" id="ttvhGear" title="Tùy chọn">⚙</button><button class="ic" id="ttvhClose" title="Đóng">×</button></div>'
    + '<div class="ttvh-set" id="ttvhSet"><label>Tên của bạn</label><input id="ttvhName" placeholder="Nhập tên để HR dễ xưng hô"/><button id="ttvhReset">Bắt đầu lại cuộc trò chuyện</button></div>'
    + '<div class="ttvh-body" id="ttvhBody"><div class="ttvh-typing" id="ttvhTyping"><span class="d"></span><span class="d"></span><span class="d"></span> Đang trả lời, xin chờ giây lát…</div></div>'
    + '<div class="ttvh-ft"><div class="ttvh-inp"><input id="ttvhInput" type="text" placeholder="Nhập tin nhắn…" maxlength="2000"/>'
    + '<button id="ttvhSend"><svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M3 11l18-8-8 18-2-7-8-3Z"/></svg></button></div>'
    + '<div class="ttvh-zalo" id="ttvhZalo"></div></div>';
  document.body.appendChild(fab); document.body.appendChild(win);

  var body = win.querySelector('#ttvhBody'), input = win.querySelector('#ttvhInput'),
      sendBtn = win.querySelector('#ttvhSend'), typing = win.querySelector('#ttvhTyping'),
      sttEl = win.querySelector('#ttvhStt'), dotEl = win.querySelector('#ttvhDot'),
      nameEl = win.querySelector('#ttvhName');

  var savedName = localStorage.getItem('ttvh_name') || '';
  if (savedName) nameEl.value = savedName;

  function scrollDown() { body.scrollTop = body.scrollHeight; }
  function addMsg(role, text, ts) {
    var cls = role === 'user' ? 'u' : (role === 'agent' ? 'a' : 'b');
    var row = document.createElement('div'); row.className = 'ttvh-row ' + cls;
    var bub = document.createElement('div'); bub.className = 'ttvh-bub';
    if (role === 'user') { bub.textContent = text; }
    else {
      // Bot/nhân viên: biến URL trong tin nhắn thành link bấm được (escape HTML trước cho an toàn)
      var esc = String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      bub.innerHTML = esc.replace(/(https?:\/\/[^\s<]+)/g, function (u) {
        var sameSite = u.indexOf(location.origin + '/') === 0 || u === location.origin;
        var tgt = sameSite ? '' : ' target="_blank" rel="noopener"';
        return '<a href="' + u + '"' + tgt + ' style="color:inherit;font-weight:700;text-decoration:underline">' + u.replace(/^https?:\/\//, '') + '</a>';
      });
    }
    row.appendChild(bub); body.insertBefore(row, typing); scrollDown();
    if (ts && ts > lastTs) lastTs = ts;
  }
  function showTyping(on) { typing.classList.toggle('show', on); if (on) scrollDown(); }
  function setMode(human) { sttEl.textContent = human ? 'Nhân viên đang hỗ trợ' : 'Tự động trả lời'; dotEl.style.background = human ? '#ffb020' : '#37d67a'; }

  async function loadConfig() {
    try { var r = await fetch('/api/chat/config'); var d = await r.json(); zaloLink = d.zaloLink || ''; if (zaloLink) win.querySelector('#ttvhZalo').innerHTML = '<a href="' + zaloLink + '" target="_blank" rel="noopener">hoặc nhắn trực tiếp qua Zalo</a>'; return d.greeting || ''; } catch (e) { return ''; }
  }
  async function loadHistory() {
    try { var r = await fetch('/api/chat/poll?sessionId=' + encodeURIComponent(SID) + '&since=0'); var d = await r.json(); (d.messages || []).forEach(function (m) { addMsg(m.role, m.text, m.ts); }); setMode(!!d.humanMode); if ((d.messages || []).length) greeted = true; } catch (e) {}
  }

  async function send() {
    var text = input.value.trim(); if (!text || sending) return;
    sending = true; input.value = ''; addMsg('user', text, Date.now());
    sendBtn.disabled = true; showTyping(true);
    try {
      var r = await fetch('/api/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: SID, text: text, name: nameEl.value.trim() || undefined }) });
      var d = await r.json();
      if (d.userTs && d.userTs > lastTs) lastTs = d.userTs;
      if (d.humanMode) { setMode(true); }
      else if (d.reply) { addMsg('bot', d.reply, d.ts); }
      else if (d.error) { addMsg('bot', 'Xin lỗi, có lỗi: ' + d.error, 0); }
    } catch (e) { addMsg('bot', 'Kết nối đang trục trặc, bạn thử lại giúp mình nhé.', 0); }
    showTyping(false); sendBtn.disabled = false; sending = false; input.focus();
  }
  async function poll() {
    try {
      var r = await fetch('/api/chat/poll?sessionId=' + encodeURIComponent(SID) + '&since=' + lastTs); var d = await r.json();
      (d.messages || []).forEach(function (m) { if (m.role !== 'user') addMsg(m.role, m.text, m.ts); else if (m.ts > lastTs) lastTs = m.ts; });
      setMode(!!d.humanMode);
      if (d.agentTyping) showTyping(true); else if (!sending) showTyping(false);
    } catch (e) {}
  }

  function open() {
    win.classList.add('open'); fab.style.display = 'none';
    if (!greeted) { loadConfig().then(function (greeting) { loadHistory().then(function () { if (!greeted && greeting) { greeted = true; addMsg('bot', greeting, 0); } }); }); }
    input.focus(); if (!pollTimer) pollTimer = setInterval(poll, 3000);
  }
  function close() { win.classList.remove('open'); fab.style.display = ''; }

  fab.addEventListener('click', open);
  win.querySelector('#ttvhClose').addEventListener('click', close);
  win.querySelector('#ttvhGear').addEventListener('click', function () { win.querySelector('#ttvhSet').classList.toggle('show'); });
  nameEl.addEventListener('change', function () { localStorage.setItem('ttvh_name', nameEl.value.trim()); });
  win.querySelector('#ttvhReset').addEventListener('click', function () {
    localStorage.removeItem('ttvh_sid'); location.reload();
  });
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
})();
