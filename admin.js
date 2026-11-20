const $ = (id) => document.getElementById(id);
let testMessages = [];
let testContextKey = '';
let testConversationId = crypto.randomUUID();

const debugPanel = document.createElement('details');
debugPanel.className = 'request-debug';
debugPanel.style.cssText = 'margin:12px 0 0;border:1px solid #263542;border-radius:9px;padding:9px;color:#90a4ad;font-size:11px';
debugPanel.innerHTML = '<summary style="cursor:pointer;color:#a7f3d0">Ver requisição enviada ao Ollama</summary><pre id="requestDebug" style="white-space:pre-wrap;max-height:220px;overflow:auto;margin:9px 0 0;color:#edf5f2;font:11px/1.5 monospace">Envie uma pergunta para visualizar o system prompt e as mensagens.</pre>';
document.querySelector('.test-form')?.before(debugPanel);

const generationPanel = document.createElement('div');
generationPanel.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px';
generationPanel.innerHTML = '<label style="margin:0">Raciocínio<select id="thinking" style="display:block;margin-top:7px;width:100%;padding:10px;border:1px solid #263542;border-radius:10px;background:#0d161f;color:#edf5f2"><option value="off">Desativado — mais rápido</option><option value="on">Ativado — mais raciocínio</option></select></label><label style="margin:0">Temperatura <output id="temperatureValue">0.3</output><input id="temperature" type="range" min="0" max="1" step="0.05" value="0.3" style="display:block;width:100%;margin-top:13px"></label>';
document.querySelector('#model')?.after(generationPanel);
$('temperature')?.addEventListener('input', () => { $('temperatureValue').value = $('temperature').value; $('temperatureValue').textContent = $('temperature').value; });

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Erro na operação');
  return data;
}

async function loadWorkspace() {
  const data = await api('/api/admin/config');
  $('model').value = data.model;
  $('thinking').value = data.thinking || 'off';
  $('temperature').value = data.temperature ?? 0.3;
  $('temperatureValue').value = $('temperature').value;
  $('temperatureValue').textContent = $('temperature').value;
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
  const button = $('saveButton');
  button.disabled = true;
  $('saveStatus').textContent = 'Salvando e gerando embeddings…';
  try {
    const data = await api('/api/admin/config', { method: 'POST', body: JSON.stringify({ model: $('model').value, prompt: $('prompt').value, training: $('training').value, thinking: $('thinking').value, temperature: Number($('temperature').value) }) });
    $('saveStatus').textContent = data.embeddings ? `Material salvo; ${data.indexedChunks} trechos indexados.` : `Configuração salva; material não alterado.`;
  } catch (error) { $('saveStatus').textContent = `Erro ao salvar: ${error.message}`; }
  finally { button.disabled = false; }
};

$('trainingFiles').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  if (!files.length) return;
  $('fileStatus').textContent = 'Lendo arquivos…';
  try {
    const pdfs = files.filter((file) => file.name.toLowerCase().endsWith('.pdf'));
    const textFiles = files.filter((file) => !file.name.toLowerCase().endsWith('.pdf'));
    const parts = await Promise.all(textFiles.map(async (file) => `\n\n--- ARQUIVO: ${file.name} ---\n${await file.text()}\n--- FIM DO ARQUIVO ---`));
    if (pdfs.length) {
      const form = new FormData();
      pdfs.forEach((file) => form.append('files', file, file.name));
      const response = await fetch('/api/extract-pdf', { method: 'POST', body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Falha ao ler o PDF');
      result.files.forEach((file) => parts.push(`\n\n--- PDF: ${file.name} ---\n${file.text}\n--- FIM DO PDF ---`));
    }
    $('training').value = ($('training').value.trim() + parts.join('')).trim();
    $('fileStatus').textContent = `${files.length} arquivo${files.length === 1 ? '' : 's'} adicionado${files.length === 1 ? '' : 's'}; salve a configuração`;
  } catch (error) { $('fileStatus').textContent = error.message; }
  finally { event.target.value = ''; }
});

$('testForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('testInput').value.trim();
  if (!text) return;
  const nextContextKey = `${$('model').value}\n${$('thinking').value}\n${$('temperature').value}\n${$('prompt').value}\n${$('training').value}`;
  if (testContextKey && testContextKey !== nextContextKey) { testMessages = []; testConversationId = crypto.randomUUID(); $('messages').innerHTML = '<div class="empty" id="empty">Faça uma pergunta para verificar se o agente<br>está respondendo com base no seu treinamento.</div>'; }
  testContextKey = nextContextKey;
  $('testInput').value = '';
  addMessage('user', text);
  testMessages.push({ role: 'user', content: text });
  const systemPreview = $('prompt').value + ($('training').value ? `\n\n=== MATERIAL DE TREINAMENTO ===\n${$('training').value}\n=== FIM DO MATERIAL ===` : '');
  $('requestDebug').textContent = JSON.stringify({ model: $('model').value, messages: [{ role: 'system', content: systemPreview }, ...testMessages] }, null, 2);
  $('testStatus').textContent = 'pensando…';
  try {
    const data = await api('/api/admin/test', { method: 'POST', body: JSON.stringify({ conversationId: testConversationId, model: $('model').value, prompt: $('prompt').value, training: $('training').value, thinking: $('thinking').value, temperature: Number($('temperature').value), messages: testMessages }) });
    const reply = data.message?.content || data.response || 'Sem resposta.';
    testMessages.push({ role: 'assistant', content: reply });
    addMessage('assistant', reply);
    $('testStatus').textContent = 'conectado';
  } catch (error) { addMessage('assistant', error.message); $('testStatus').textContent = 'erro'; }
});

$('testInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('testForm').requestSubmit();
  }
});
