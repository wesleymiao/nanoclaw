// Static single-page chat UI served by WebChannel at GET /.
// Kept as a plain template string (no bundler/build step) to match the
// zero-dependency style of the rest of the channel implementations.
export const WEB_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>NanoClaw</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    color-scheme: dark;
    --bg: #0e1015;
    --bg-panel: #16191f;
    --bg-panel-2: #1c2029;
    --bg-hover: #232834;
    --bg-active: #2a3142;
    --border: #262b36;
    --text: #e6e8ec;
    --text-muted: #8a90a0;
    --accent: #6d8bff;
    --accent-dim: #3d4d99;
    --bubble-user: #3a4a8f;
    --bubble-assistant: #1f232c;
    --ok: #3ecf8e;
    --err: #ff6b6b;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 0;
    height: 100vh;
    background: var(--bg);
    color: var(--text);
    display: flex;
  }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: #2e3441; border-radius: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }

  /* ---- Login screen ---- */
  #login {
    margin: auto;
    width: 320px;
    padding: 2rem;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 12px 40px rgba(0,0,0,0.4);
  }
  #login h2 { margin: 0 0 0.25rem; font-size: 1.3rem; }
  #login p.tagline { margin: 0 0 1.5rem; color: var(--text-muted); font-size: 0.85rem; }
  #login input {
    display: block;
    width: 100%;
    margin: 0.5rem 0;
    padding: 0.6rem 0.7rem;
    background: var(--bg-panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 0.95rem;
  }
  #login input:focus { outline: none; border-color: var(--accent); }
  #login button {
    width: 100%;
    margin-top: 0.75rem;
    padding: 0.65rem;
    background: var(--accent);
    color: #0e1015;
    border: none;
    border-radius: 8px;
    font-weight: 600;
    font-size: 0.95rem;
    cursor: pointer;
  }
  #login button:hover { background: #83a0ff; }
  #loginError { color: var(--err); font-size: 0.85rem; margin-top: 0.6rem; min-height: 1.1em; }

  /* ---- App shell ---- */
  #app { display: none; width: 100%; height: 100%; }
  #app.visible { display: flex; }

  #sidebar {
    width: 260px;
    flex-shrink: 0;
    background: var(--bg-panel);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }
  #sidebarHeader {
    padding: 0.9rem 1rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  #sidebarHeader .brand { font-weight: 700; font-size: 1.05rem; letter-spacing: -0.02em; }
  #userRow {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.5rem;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  #statusDot { width: 8px; height: 8px; border-radius: 50%; background: var(--err); flex-shrink: 0; transition: background 0.2s; }
  #statusDot.connected { background: var(--ok); }
  #logoutBtn {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    text-decoration: underline;
    padding: 0;
  }
  #logoutBtn:hover { color: var(--text); }

  #convListWrap { flex: 1; overflow-y: auto; padding: 0.5rem; }
  #convList button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    text-align: left;
    padding: 0.55rem 0.65rem;
    margin: 2px 0;
    border: none;
    background: none;
    color: var(--text);
    cursor: pointer;
    border-radius: 8px;
    font-size: 0.88rem;
    transition: background 0.12s;
  }
  #convList button .conv-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%; }
  #convList button:hover { background: var(--bg-hover); }
  #convList button.active { background: var(--bg-active); }
  #emptyConvHint { color: var(--text-muted); font-size: 0.8rem; padding: 0.6rem 0.65rem; }

  #newConvRow { padding: 0.6rem; border-top: 1px solid var(--border); }
  #newConv {
    width: 100%;
    padding: 0.55rem 0.65rem;
    background: var(--bg-panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 0.85rem;
  }
  #newConv:focus { outline: none; border-color: var(--accent); }
  #newConv::placeholder { color: var(--text-muted); }

  /* ---- Main chat pane ---- */
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #chatHeader {
    padding: 0.8rem 1.2rem;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    font-size: 0.95rem;
    min-height: 1.3em;
  }
  #messages { flex: 1; overflow-y: auto; padding: 1rem 1.2rem; display: flex; flex-direction: column; gap: 0.7rem; }
  #emptyState {
    margin: auto;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.9rem;
    max-width: 320px;
  }

  .row { display: flex; }
  .row.me { justify-content: flex-end; }
  .row.them { justify-content: flex-start; }
  .bubble {
    max-width: 72%;
    padding: 0.55rem 0.8rem;
    border-radius: 14px;
    font-size: 0.92rem;
    line-height: 1.45;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .row.me .bubble { background: var(--bubble-user); border-bottom-right-radius: 4px; }
  .row.them .bubble { background: var(--bubble-assistant); border-bottom-left-radius: 4px; }
  .bubble code {
    background: rgba(255,255,255,0.08);
    padding: 0.1em 0.35em;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.87em;
  }
  .bubble pre {
    background: rgba(0,0,0,0.35);
    padding: 0.6em 0.7em;
    border-radius: 8px;
    overflow-x: auto;
    margin: 0.4em 0;
  }
  .bubble pre code { background: none; padding: 0; }
  .bubble a { color: var(--accent); }
  .meta { font-size: 0.7rem; color: var(--text-muted); margin-top: 3px; }
  .row.me .meta { text-align: right; }

  .typing .bubble { display: flex; gap: 4px; align-items: center; padding: 0.65rem 0.9rem; }
  .typing .dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted);
    animation: bounce 1.2s infinite ease-in-out;
  }
  .typing .dot:nth-child(2) { animation-delay: 0.15s; }
  .typing .dot:nth-child(3) { animation-delay: 0.3s; }
  @keyframes bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
    30% { transform: translateY(-4px); opacity: 1; }
  }

  #composerWrap { border-top: 1px solid var(--border); padding: 0.7rem 1rem; }
  #composer { display: flex; align-items: flex-end; gap: 0.5rem; background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 12px; padding: 0.4rem; }
  #composer:focus-within { border-color: var(--accent); }
  #composerInput {
    flex: 1;
    resize: none;
    border: none;
    background: none;
    color: var(--text);
    font-size: 0.92rem;
    font-family: inherit;
    padding: 0.4rem 0.5rem;
    max-height: 140px;
    line-height: 1.4;
  }
  #composerInput:focus { outline: none; }
  #composerInput::placeholder { color: var(--text-muted); }
  #sendBtn {
    background: var(--accent);
    color: #0e1015;
    border: none;
    border-radius: 8px;
    padding: 0.5rem 0.9rem;
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  #sendBtn:disabled { background: var(--accent-dim); color: var(--text-muted); cursor: default; }
  #sendBtn:not(:disabled):hover { background: #83a0ff; }
</style>
</head>
<body>
  <div id="login">
    <h2>NanoClaw</h2>
    <p class="tagline">Sign in to start chatting</p>
    <input id="username" placeholder="Username" autocomplete="username" />
    <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
    <button id="loginBtn">Log in</button>
    <div id="loginError"></div>
  </div>

  <div id="app">
    <div id="sidebar">
      <div id="sidebarHeader">
        <div class="brand">NanoClaw</div>
        <div id="userRow">
          <span id="statusDot"></span>
          <span id="usernameLabel"></span>
          <button id="logoutBtn">Log out</button>
        </div>
      </div>
      <div id="convListWrap">
        <div id="convList"></div>
      </div>
      <div id="newConvRow">
        <input id="newConv" placeholder="+ New conversation (title, Enter)" />
      </div>
    </div>
    <div id="main">
      <div id="chatHeader"></div>
      <div id="messages"></div>
      <div id="composerWrap">
        <div id="composer">
          <textarea id="composerInput" rows="1" placeholder="Message NanoClaw..."></textarea>
          <button id="sendBtn">Send</button>
        </div>
      </div>
    </div>
  </div>

<script>
let currentConversationId = null;
let currentConversationName = '';
let eventSource = null;
let typingEl = null;

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts));
  if (!res.ok) throw new Error('Request failed: ' + res.status);
  return res.json();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Minimal, safe markdown-ish rendering: escape everything first, then apply
// a small set of inline/block substitutions. No HTML from the model is ever
// trusted directly.
function renderContent(text) {
  let html = escapeHtml(text);
  html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, (_, code) => '<pre><code>' + code.replace(/^\\n/, '') + '</code></pre>');
  html = html.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return html;
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

document.getElementById('loginBtn').onclick = doLogin;
document.getElementById('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

async function doLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!username || !password) {
    errEl.textContent = 'Enter a username and password.';
    return;
  }
  try {
    await api('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').classList.add('visible');
    document.getElementById('usernameLabel').textContent = username;
    await loadConversations();
    connectStream();
  } catch (e) {
    errEl.textContent = 'Login failed — check your username and password.';
  }
}

document.getElementById('logoutBtn').onclick = async () => {
  try { await api('/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  if (eventSource) eventSource.close();
  location.reload();
};

async function loadConversations() {
  const conversations = await api('/api/conversations');
  const list = document.getElementById('convList');
  list.innerHTML = '';
  if (conversations.length === 0) {
    const hint = document.createElement('div');
    hint.id = 'emptyConvHint';
    hint.textContent = 'No conversations yet — create one below.';
    list.appendChild(hint);
  }
  for (const c of conversations) {
    const btn = document.createElement('button');
    btn.className = c.conversationId === currentConversationId ? 'active' : '';
    const name = document.createElement('span');
    name.className = 'conv-name';
    name.textContent = c.name;
    btn.appendChild(name);
    btn.onclick = () => selectConversation(c.conversationId, c.name);
    list.appendChild(btn);
  }
  if (!currentConversationId && conversations.length > 0) {
    await selectConversation(conversations[0].conversationId, conversations[0].name);
  }
}

async function selectConversation(conversationId, name) {
  currentConversationId = conversationId;
  currentConversationName = name || conversationId;
  document.getElementById('chatHeader').textContent = currentConversationName;
  await loadConversations();
  const history = await api('/api/history?conversationId=' + encodeURIComponent(conversationId));
  const messages = document.getElementById('messages');
  messages.innerHTML = '';
  typingEl = null;
  if (history.length === 0) {
    renderEmptyState();
    return;
  }
  for (const m of history) {
    appendMessage(!!m.is_from_me, m.content, m.timestamp);
  }
  messages.scrollTop = messages.scrollHeight;
}

function renderEmptyState() {
  const messages = document.getElementById('messages');
  messages.innerHTML = '';
  const div = document.createElement('div');
  div.id = 'emptyState';
  div.textContent = 'No messages yet. Say hello to get started.';
  messages.appendChild(div);
}

function appendMessage(isFromMe, content, timestamp) {
  const messages = document.getElementById('messages');
  const existingEmpty = document.getElementById('emptyState');
  if (existingEmpty) existingEmpty.remove();

  const row = document.createElement('div');
  row.className = 'row ' + (isFromMe ? 'them' : 'me');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderContent(content);
  row.appendChild(bubble);
  if (timestamp) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = formatTime(timestamp);
    row.appendChild(meta);
  }
  messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
}

function showTyping() {
  hideTyping();
  const messages = document.getElementById('messages');
  const row = document.createElement('div');
  row.className = 'row them typing';
  row.innerHTML = '<div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
  messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
  typingEl = row;
}

function hideTyping() {
  if (typingEl) {
    typingEl.remove();
    typingEl = null;
  }
}

document.getElementById('newConv').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const title = e.target.value.trim();
  if (!title) return;
  const { conversationId, name } = await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  e.target.value = '';
  await selectConversation(conversationId, name);
});

async function sendMessage() {
  const input = document.getElementById('composerInput');
  const text = input.value.trim();
  if (!text || !currentConversationId) return;
  appendMessage(false, text, new Date().toISOString());
  input.value = '';
  autoGrow(input);
  setSending(true);
  showTyping();
  try {
    await api('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: currentConversationId, text }),
    });
  } finally {
    setSending(false);
  }
}

function setSending(sending) {
  document.getElementById('sendBtn').disabled = sending;
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

document.getElementById('sendBtn').onclick = sendMessage;
const composerInput = document.getElementById('composerInput');
composerInput.addEventListener('input', () => autoGrow(composerInput));
composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function connectStream() {
  eventSource = new EventSource('/api/stream');
  eventSource.onopen = () => {
    document.getElementById('statusDot').classList.add('connected');
  };
  eventSource.onerror = () => {
    document.getElementById('statusDot').classList.remove('connected');
  };
  eventSource.onmessage = (evt) => {
    const data = JSON.parse(evt.data);
    if (data.jid && currentConversationId && data.jid.endsWith(':' + currentConversationId)) {
      hideTyping();
      appendMessage(true, data.text, new Date().toISOString());
    }
  };
}
</script>
</body>
</html>
`;
