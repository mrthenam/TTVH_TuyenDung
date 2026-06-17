/* Widget chat khách hàng — Thịnh Thế Vinh Hoa. Tự chèn UI + xử lý. */
(function () {
  // ---- session theo từng khách (nhớ ngữ cảnh) ----
  var SID = localStorage.getItem('ttvh_sid');
  if (!SID) { SID = 'web_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('ttvh_sid', SID); }
  var lastTs = 0, pollTimer = null, greeted = false, opened = false;

  // ---- CSS ----
  var css = ''
    + '.ttvh-fab{position:fixed;right:22px;bottom:22px;z-index:9998;width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;'
    + 'background:linear-gradient(135deg,#ff7a1a,#e0342b);color:#fff;font-size:26px;box-shadow:0 14px 34px -10px rgba(224,52,43,.6);transition:transform .2s}'
    + '.ttvh-fab:hover{transform:scale(1.08)}'
    + '.ttvh-fab .dot{position:absolute;top:10px;right:12px;width:11px;height:11px;border-radius:50%;background:#37d67a;border:2px solid #fff}'
    + '.ttvh-win{position:fixed;right:22px;bottom:94px;z-index:9999;width:370px;max-width:calc(100vw - 28px);height:540px;max-height:calc(100vh - 130px);'
    + 'background:#fff;border-radius:18px;box-shadow:0 30px 70px -20px rgba(40,20,10,.5);display:none;flex-direction:column;overflow:hidden;font-family:inherit}'
    + '.ttvh-win.open{display:flex}'
    + '.ttvh-hd{background:linear-gradient(135deg,#ff7a1a,#e0342b);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:11px}'
    + '.ttvh-hd .av{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.22);display:grid;place-items:center;font-size:20px}'
    + '.ttvh-hd b{font-size:15px;display:block;line-height:1.2}.ttvh-hd small{font-size:12px;opacity:.9}'
    + '.ttvh-hd .x{margin-left:auto;background:none;border:none;color:#fff;font-size:22px;cursor:pointer;opacity:.9}'
    + '.ttvh-body{flex:1;overflow-y:auto;padding:16px;background:#fff8f0;display:flex;flex-direction:column;gap:10px}'
    + '.ttvh-row{display:flex;max-width:82%}.ttvh-row.u{align-self:flex-end}.ttvh-row.b{align-self:flex-start}'
    + '.ttvh-bub{padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-break:break-word}'
    + '.ttvh-row.u .ttvh-bub{background:linear-gradient(135deg,#ff7a1a,#e0342b);color:#fff;border-bottom-right-radius:4px}'
    + '.ttvh-row.b .ttvh-bub{background:#fff;border:1px solid rgba(54,28,18,.1);color:#2a1810;border-bottom-left-radius:4px}'
    + '.ttvh-row.a .ttvh-bub{background:#eef6ff;border:1px solid #cfe3ff;color:#173a5e;border-bottom-left-radius:4px}'
    + '.ttvh-meta{font-size:10px;color:#a08;opacity:0;margin:2px 4px}'
    + '.ttvh-typing{align-self:flex-start;display:none;align-items:center;gap:8px;color:#8b7060;font-size:13px;padding:2px 4px}'
    + '.ttvh-typing.show{display:flex}'
    + '.ttvh-typing .d{width:7px;height:7px;border-radius:50%;background:#e0342b;animation:ttvhb 1s infinite}'
    + '.ttvh-typing .d:nth-child(2){animation-delay:.15s}.ttvh-typing .d:nth-child(3){animation-delay:.3s}'
    + '@keyframes ttvhb{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}'
    + '.ttvh-human{text-align:center;font-size:12px;color:#1f9e6e;background:#e7f8ee;border:1px solid #bce8d0;border-radius:10px;padding:6px 10px;display:none}'
    + '.ttvh-human.show{display:block}'
    + '.ttvh-ft{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(54,28,18,.08);background:#fff}'
    + '.ttvh-ft input{flex:1;border:1px solid rgba(54,28,18,.18);border-radius:12px;padding:11px 14px;font-family:inherit;font-size:14px;outline:none}'
    + '.ttvh-ft input:focus{border-color:#e0342b}'
    + '.ttvh-ft button{border:none;background:linear-gradient(135deg,#ff7a1a,#e0342b);color:#fff;border-radius:12px;width:46px;font-size:18px;cursor:pointer}'
    + '.ttvh-ft button:disabled{opacity:.5;cursor:default}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ---- DOM ----
  var fab = document.createElement('button');
  fab.className = 'ttvh-fab'; fab.innerHTML = '💬<span class="dot"></span>'; fab.title = 'Chat tư vấn tuyển dụng';
  var win = document.createElement('div'); win.className = 'ttvh-win';
  win.innerHTML =
    '<div class="ttvh-hd"><div class="av">🧋</div><div><b>Tư vấn tuyển dụng</b><small>Thịnh Thế Vinh Hoa F&B</small></div><button class="x" aria-label="Đóng">×</button></div>'
    + '<div class="ttvh-body" id="ttvhBody"><div class="ttvh-human" id="ttvhHuman">👤 Nhân viên đang hỗ trợ bạn</div>'
    + '<div class="ttvh-typing" id="ttvhTyping"><span class="d"></span><span class="d"></span><span class="d"></span> Đang trả lời, xin chờ giây lát…</div></div>'
    + '<div class="ttvh-ft"><input id="ttvhInput" type="text" placeholder="Nhập tin nhắn…" maxlength="2000" /><button id="ttvhSend">➤</button></div>';
  document.body.appendChild(fab); document.body.appendChild(win);

  var body = win.querySelector('#ttvhBody'), input = win.querySelector('#ttvhInput'),
      sendBtn = win.querySelector('#ttvhSend'), typing = win.querySelector('#ttvhTyping'),
      humanBar = win.querySelector('#ttvhHuman');

  function scrollDown() { body.scrollTop = body.scrollHeight; }
  function addMsg(role, text, ts) {
    var cls = role === 'user' ? 'u' : (role === 'agent' ? 'a' : 'b');
    var row = document.createElement('div'); row.className = 'ttvh-row ' + cls;
    var bub = document.createElement('div'); bub.className = 'ttvh-bub'; bub.textContent = text;
    row.appendChild(bub); body.insertBefore(row, typing); scrollDown();
    if (ts && ts > lastTs) lastTs = ts;
  }
  function showTyping(on) { typing.classList.toggle('show', on); if (on) scrollDown(); }

  async function loadHistory() {
    try {
      var r = await fetch('/api/chat/poll?sessionId=' + encodeURIComponent(SID) + '&since=0');
      var d = await r.json();
      (d.messages || []).forEach(function (m) { addMsg(m.role, m.text, m.ts); });
      humanBar.classList.toggle('show', !!d.humanMode);
      if ((d.messages || []).length) greeted = true;
    } catch (e) {}
  }
  async function greet() {
    if (greeted) return; greeted = true;
    try { var r = await fetch('/api/chat/greeting'); var d = await r.json(); if (d.greeting) addMsg('bot', d.greeting, 0); } catch (e) {}
  }

  async function send() {
    var text = input.value.trim(); if (!text) return;
    input.value = ''; addMsg('user', text, Date.now());
    sendBtn.disabled = true; showTyping(true);
    try {
      var r = await fetch('/api/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: SID, text: text }) });
      var d = await r.json();
      if (d.userTs && d.userTs > lastTs) lastTs = d.userTs;
      if (d.humanMode) { humanBar.classList.add('show'); /* nhân viên sẽ trả lời, poll sẽ nhận */ }
      else if (d.reply) { addMsg('bot', d.reply, d.ts); }
    } catch (e) { addMsg('bot', 'Xin lỗi, kết nối đang gặp trục trặc. Bạn thử lại giúp mình nhé.', 0); }
    showTyping(false); sendBtn.disabled = false; input.focus();
  }

  async function poll() {
    try {
      var r = await fetch('/api/chat/poll?sessionId=' + encodeURIComponent(SID) + '&since=' + lastTs);
      var d = await r.json();
      (d.messages || []).forEach(function (m) { if (m.role !== 'user') addMsg(m.role, m.text, m.ts); else if (m.ts > lastTs) lastTs = m.ts; });
      humanBar.classList.toggle('show', !!d.humanMode);
      if (d.agentTyping) showTyping(true); else if (typing.classList.contains('show') && !sendBtn.disabled) showTyping(false);
    } catch (e) {}
  }

  function open() {
    win.classList.add('open'); fab.style.display = 'none'; opened = true;
    if (!greeted) { loadHistory().then(greet); }
    input.focus();
    if (!pollTimer) pollTimer = setInterval(poll, 3000);
  }
  function close() { win.classList.remove('open'); fab.style.display = ''; }

  fab.addEventListener('click', open);
  win.querySelector('.x').addEventListener('click', close);
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
})();
