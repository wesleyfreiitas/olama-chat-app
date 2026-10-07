const $ = (id) => document.getElementById(id);
let testMessages = [];

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Erro na operação');
  return data;
}

async function loadWorkspace() {
  const data = await api('/api/admin/config');
  $('model').value = data.model;
  $('prompt').value = data.prompt;
  $('training').value = data.training;
  $('login').classList.add('hidden');
  $('workspace').classList.remove('hidden');
}

function addMessage(role, text) {
  $('empty')?.remove();
  const row = document.createElement('div');
  row.className = `message ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.appendChild(bubble);
  $('messages').appendChild(row);
  $('messages').scrollTop = $('messages').scrollHeight;
}

$('loginButton').onclick = async () => {
  try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) }); await loadWorkspace(); }
  catch (error) { $('loginStatus').textContent = error.message; }
};
$('password').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('loginButton').click(); });

$('saveButton').onclick = async () => {
  try { const data = await api('/api/admin/config', { method: 'POST', body: JSON.stringify({ model: $('model').value, prompt: $('prompt').value, training: $('training').value }) }); $('saveStatus').textContent = `Salvo em ${data.storage}.`; }
  catch (error) { $('saveStatus').textContent = error.message; }
};

$('testForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('testInput').value.trim();
  if (!text) return;
  $('testInput').value = '';
  addMessage('user', text);
  testMessages.push({ role: 'user', content: text });
  $('testStatus').textContent = 'pensando…';
  try {
    const data = await api('/api/admin/test', { method: 'POST', body: JSON.stringify({ model: $('model').value, prompt: $('prompt').value, training: $('training').value, messages: testMessages }) });
    const reply = data.message?.content || data.response || 'Sem resposta.';
    testMessages.push({ role: 'assistant', content: reply });
    addMessage('assistant', reply);
    $('testStatus').textContent = 'conectado';
  } catch (error) { addMessage('assistant', error.message); $('testStatus').textContent = 'erro'; }
});
