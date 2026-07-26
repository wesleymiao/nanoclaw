// Static single-page chat UI served by WebChannel at GET /.
// Kept as a plain template string (no bundler/build step) to match the
// zero-dependency style of the rest of the channel implementations.
export const WEB_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>NanoClaw Web</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; display: flex; height: 100vh; }
  #login { margin: auto; padding: 2rem; border: 1px solid #ccc; border-radius: 8px; }
  #login input { display: block; margin: 0.5rem 0; padding: 0.4rem; width: 220px; }
  #app { display: none; width: 100%; height: 100%; }
  #sidebar { width: 240px; border-right: 1px solid #ccc; overflow-y: auto; padding: 0.5rem; box-sizing: border-box; }
  #sidebar h3 { margin: 0.25rem 0; font-size: 0.9rem; }
  #convList button { display: block; width: 100%; text-align: left; padding: 0.4rem; margin: 2px 0; border: none; background: none; cursor: pointer; border-radius: 4px; }
  #convList button.active { background: #d0e6ff; }
  #newConv { width: 100%; margin-top: 0.5rem; padding: 0.4rem; }
  #main { flex: 1; display: flex; flex-direction: column; }
  #messages { flex: 1; overflow-y: auto; padding: 1rem; }
  .msg { margin: 0.4rem 0; }
  .msg .sender { font-weight: bold; margin-right: 0.4rem; }
  #composer { display: flex; border-top: 1px solid #ccc; padding: 0.5rem; }
  #composer input { flex: 1; padding: 0.5rem; }
  #composer button { padding: 0.5rem 1rem; }
</style>
</head>
<body>
  <div id="login">
    <h2>NanoClaw Web</h2>
    <input id="username" placeholder="username" autocomplete="username" />
    <input id="password" type="password" placeholder="password" autocomplete="current-password" />
    <button id="loginBtn">Log in</button>
    <div id="loginError" style="color: red;"></div>
  </div>

  <div id="app">
    <div id="sidebar">
      <h3>Conversations</h3>
      <div id="convList"></div>
      <input id="newConv" placeholder="New conversation title + Enter" />
    </div>
    <div id="main">
      <div id="messages"></div>
      <div id="composer">
        <input id="composerInput" placeholder="Type a message..." />
        <button id="sendBtn">Send</button>
      </div>
    </div>
  </div>

<script>
let currentConversationId = null;
let eventSource = null;

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts));
  if (!res.ok) throw new Error('Request failed: ' + res.status);
  return res.json();
}

document.getElementById('loginBtn').onclick = async () => {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  try {
    await api('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    await loadConversations();
    connectStream();
  } catch (e) {
    document.getElementById('loginError').textContent = 'Login failed';
  }
};

async function loadConversations() {
  const conversations = await api('/api/conversations');
  const list = document.getElementById('convList');
  list.innerHTML = '';
  for (const c of conversations) {
    const btn = document.createElement('button');
    btn.textContent = c.name;
    btn.className = c.conversationId === currentConversationId ? 'active' : '';
    btn.onclick = () => selectConversation(c.conversationId);
    list.appendChild(btn);
  }
}

async function selectConversation(conversationId) {
  currentConversationId = conversationId;
  await loadConversations();
  const history = await api('/api/history?conversationId=' + encodeURIComponent(conversationId));
  const messages = document.getElementById('messages');
  messages.innerHTML = '';
  for (const m of history) {
    appendMessage(m.sender_name || (m.is_from_me ? 'bot' : 'you'), m.content);
  }
}

function appendMessage(sender, content) {
  const messages = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg';
  const senderSpan = document.createElement('span');
  senderSpan.className = 'sender';
  senderSpan.textContent = sender + ':';
  div.appendChild(senderSpan);
  div.appendChild(document.createTextNode(content));
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

document.getElementById('newConv').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const title = e.target.value.trim();
  if (!title) return;
  const { conversationId } = await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  e.target.value = '';
  await selectConversation(conversationId);
});

async function sendMessage() {
  const input = document.getElementById('composerInput');
  const text = input.value.trim();
  if (!text || !currentConversationId) return;
  appendMessage('you', text);
  input.value = '';
  await api('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: currentConversationId, text }),
  });
}

document.getElementById('sendBtn').onclick = sendMessage;
document.getElementById('composerInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

function connectStream() {
  eventSource = new EventSource('/api/stream');
  eventSource.onmessage = (evt) => {
    const data = JSON.parse(evt.data);
    if (data.jid && data.jid.endsWith(':' + currentConversationId)) {
      appendMessage('assistant', data.text);
    }
  };
}
</script>
</body>
</html>
`;
