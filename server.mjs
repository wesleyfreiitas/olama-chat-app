import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
try { const envText = await readFile(join(root, '.env'), 'utf8'); for (const line of envText.split(/\r?\n/)) { const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, ''); } } catch {}
const port = Number(process.env.PORT || 3000);
const ollamaUrl = process.env.OLLAMA_URL || 'http://165.227.113.169:11434/api/chat';
const embeddingModel = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const ollamaTemperature = Number(process.env.OLLAMA_TEMPERATURE || 0.3);
const ollamaContext = Number(process.env.OLLAMA_NUM_CTX || 4096);
const ollamaPredict = Number(process.env.OLLAMA_NUM_PREDICT || 256);
const pdfPython = process.env.PDF_PYTHON || 'C:\\Users\\User\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const configPath = join(root, 'agent-config.json');
const dbPath = join(root, 'llama-chat.sqlite');
const db = new DatabaseSync(dbPath);
db.exec(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (conversation_id) REFERENCES conversations(id)); CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);`);
const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
const sessionTtlMs = 4 * 60 * 60 * 1000;
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
let hasSupabase = Boolean(supabaseUrl && supabaseKey);
const sessions = new Map();
let indexedTrainingHash = '';
let agentConfig = { prompt: 'Você é um assistente útil, claro e direto. Responda sempre em português do Brasil. Se não souber algo, diga que não sabe.', training: '', model: 'llama3.2:1b', thinking: 'off', temperature: ollamaTemperature };
const configRows = db.prepare('SELECT key, value FROM agent_config').all();
if (!configRows.length) { try { const legacy = JSON.parse(await readFile(configPath, 'utf8')); agentConfig = { ...agentConfig, ...legacy }; } catch {} }
for (const row of configRows) agentConfig[row.key] = row.value;
async function supabaseRequest(path, options = {}) { const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) } }); const text = await response.text(); if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${text}`); return text.trim() ? JSON.parse(text) : null; }
function ollamaEndpoint(path) { const url = new URL(ollamaUrl); url.pathname = path; url.search = ''; return url.toString(); }
async function createEmbedding(text) {
  const modern = await fetch(ollamaEndpoint('/api/embed'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: embeddingModel, input: text }) });
  const modernData = await modern.json().catch(() => ({}));
  const modernEmbedding = modernData.embeddings?.[0] || modernData.embedding;
  if (modern.ok && Array.isArray(modernEmbedding)) return modernEmbedding;
  const legacy = await fetch(ollamaEndpoint('/api/embeddings'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: embeddingModel, prompt: text }) });
  const legacyData = await legacy.json().catch(() => ({}));
  if (legacy.ok && Array.isArray(legacyData.embedding)) return legacyData.embedding;
  throw new Error(`Ollama não retornou embedding para ${embeddingModel}. Instale esse modelo no servidor Ollama.`);
}
function splitIntoChunks(text, maxChars = 1400, overlap = 220) {
  const normalized = String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const chunks = []; let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) { const boundary = normalized.lastIndexOf(' ', end); if (boundary > start + maxChars * 0.6) end = boundary; }
    const chunk = normalized.slice(start, end).trim(); if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    const overlapStart = Math.max(end - overlap, start + 1);
    const nextWord = normalized.indexOf(' ', overlapStart);
    start = nextWord > overlapStart && nextWord < end ? nextWord + 1 : overlapStart;
  }
  return chunks;
}
async function rebuildEmbeddings(training) {
  if (!hasSupabase) return 0;
  await supabaseRequest('training_chunks?material_id=eq.1', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  const chunks = splitIntoChunks(training);
  if (!chunks.length) return 0;
  const rows = [];
  for (let index = 0; index < chunks.length; index += 1) rows.push({ material_id: 1, chunk_index: index, content: chunks[index], embedding: await createEmbedding(chunks[index]) });
  await supabaseRequest('training_chunks', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
  return rows.length;
}
async function searchTraining(question) {
  if (!hasSupabase || !question) return [];
  const embedding = await createEmbedding(question);
  return supabaseRequest('rpc/match_training_chunks', { method: 'POST', body: JSON.stringify({ query_embedding: embedding, match_threshold: 0.35, match_count: 6 }) });
}
async function loadAgentConfig() { if (!hasSupabase) return agentConfig; const rows = await supabaseRequest('agent_config?select=key,value'); for (const row of rows) if (row.key !== 'training') agentConfig[row.key] = row.value; const material = await supabaseRequest('training_material?select=content&active=eq.true&order=updated_at.desc&limit=1'); if (material[0]) agentConfig.training = material[0].content; return agentConfig; }
function trainingHash(training) { return crypto.createHash('sha256').update(String(training || ''), 'utf8').digest('hex'); }
const INDEX_FORMAT_VERSION = 'chunks-v2';
function indexedTrainingKey(training) { return trainingHash(`${INDEX_FORMAT_VERSION}:${String(training || '')}`); }
async function saveAgentConfig(next) { const previousHash = trainingHash(agentConfig.training); agentConfig = next; const nextHash = trainingHash(agentConfig.training); const trainingChanged = previousHash !== nextHash; if (hasSupabase) { await supabaseRequest('agent_config?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(Object.entries({ prompt: agentConfig.prompt, model: agentConfig.model, thinking: agentConfig.thinking, temperature: String(agentConfig.temperature), num_ctx: String(agentConfig.num_ctx), num_predict: String(agentConfig.num_predict) }).map(([key, value]) => ({ key, value }))) }); await supabaseRequest('training_material?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ id: 1, title: 'Base principal do agente', content: agentConfig.training, source: 'painel admin', active: true, updated_at: new Date().toISOString() }]) }); if (trainingChanged || indexedTrainingHash !== indexedTrainingKey(agentConfig.training)) { const indexedChunks = await rebuildEmbeddings(agentConfig.training); indexedTrainingHash = indexedTrainingKey(agentConfig.training); return { indexedChunks, trainingIndexed: true }; } return { indexedChunks: 0, trainingIndexed: false }; } else { const save = db.prepare('INSERT INTO agent_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'); for (const [key, value] of Object.entries(agentConfig)) save.run(key, value); return { indexedChunks: 0, trainingIndexed: false }; } }
if (hasSupabase) { try { await loadAgentConfig(); indexedTrainingHash = trainingHash(agentConfig.training); console.log('Persistência: Supabase.'); } catch (error) { hasSupabase = false; console.error(`Supabase indisponível; usando SQLite: ${error.message}`); } }
console.log(process.env.ADMIN_PASSWORD ? 'Admin configurado via ADMIN_PASSWORD.' : `Senha admin temporária: ${adminPassword}`);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

async function jsonBody(req) { return JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
function isAdmin(req) { const token = (req.headers.cookie || '').match(/admin_session=([^;]+)/)?.[1]; const expiresAt = token ? sessions.get(token) : null; if (!expiresAt) return false; if (expiresAt <= Date.now()) { sessions.delete(token); return false; } return true; }
function unauthorized(res) { return send(res, 401, JSON.stringify({ error: 'Não autenticado' })); }

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseMultipart(body, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error('Formato de upload inválido');
  const boundary = `--${match[1] || match[2]}`;
  const raw = body.toString('latin1');
  const parts = [];
  for (const section of raw.split(boundary).slice(1)) {
    if (section.startsWith('--')) continue;
    const headerEnd = section.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = section.slice(0, headerEnd);
    const name = headers.match(/filename="([^"]+)"/i)?.[1];
    if (name) { const content = section.slice(headerEnd + 4).replace(/\r\n$/, ''); parts.push({ name, data: Buffer.from(content, 'latin1') }); }
  }
  return parts;
}

function extractPdf(data) {
  return new Promise((resolve, reject) => {
    const script = "import sys\nfrom io import BytesIO\nfrom pypdf import PdfReader\nreader = PdfReader(BytesIO(sys.stdin.buffer.read()))\ntext = '\\n\\n'.join((page.extract_text() or '') for page in reader.pages)\nsys.stdout.buffer.write(text.encode('utf-8', errors='replace'))";
    const child = spawn(pdfPython, ['-c', script], { windowsHide: true });
    const output = []; const errors = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(output).toString('utf8')) : reject(new Error(Buffer.concat(errors).toString('utf8') || `Leitura do PDF falhou (código ${code})`)));
    child.stdin.end(data);
  });
}

const knowledgeTool = {
  type: 'function',
  function: {
    name: 'buscar_conhecimento',
    description: 'Busca informações relevantes na base de conhecimento do agente quando necessário.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Pergunta ou assunto a pesquisar.' } },
      required: ['query']
    }
  }
};
async function runOllamaAgent(model, prompt, messages, useKnowledge, generation = {}) {
  const thinking = String(generation.thinking ?? agentConfig.thinking ?? 'off') === 'on';
  const temperature = Number(generation.temperature ?? agentConfig.temperature ?? ollamaTemperature);
  const contextLength = Number(generation.num_ctx ?? agentConfig.num_ctx ?? ollamaContext);
  const predictLength = Number(generation.num_predict ?? agentConfig.num_predict ?? ollamaPredict);
  const knowledgeInstruction = '\n\nRegras obrigatórias para consulta de conhecimento: Quando consultar a base interna, use as informações retornadas para responder diretamente com as suas próprias palavras de forma natural e acolhedora. NUNCA faça referências técnicas como "análise de similaridade", pontuações, scores, porcentagens de match, IDs ou termos como "com base nos valores de similarity".';
  const workingMessages = [{ role: 'system', content: String(prompt || '') + (useKnowledge ? knowledgeInstruction : '') }, ...messages];
  const tools = useKnowledge ? [knowledgeTool] : undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestBody = { model, messages: workingMessages, stream: false, think: thinking, options: { temperature, num_ctx: contextLength, num_predict: predictLength } };
    if (tools) requestBody.tools = tools;
    const upstream = await fetch(ollamaUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
    const raw = await upstream.text();
    if (!upstream.ok) throw new Error(`Ollama HTTP ${upstream.status}: ${raw}`);
    const data = JSON.parse(raw || '{}');
    const assistant = data.message || {};
    const calls = assistant.tool_calls || [];
    if (!calls.length || !useKnowledge) return data;
    workingMessages.push(assistant);
    for (const call of calls) {
      const args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call.function?.arguments || {});
      const matches = await searchTraining(String(args.query || ''));
      const textMatches = Array.isArray(matches)
        ? matches.map((m, idx) => `[Trecho ${idx + 1}]:\n${m.content || ''}`).join('\n\n')
        : '';
      const toolPayload = textMatches
        ? `Informações encontradas na base interna sobre "${args.query || ''}":\n\n${textMatches}`
        : `Nenhuma informação relevante encontrada na base interna para "${args.query || ''}".`;
      workingMessages.push({ role: 'tool', content: toolPayload });
    }
  }
  throw new Error('O agente atingiu o limite de consultas à ferramenta de conhecimento.');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      if (hasSupabase) await loadAgentConfig();
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const incoming = JSON.parse(raw || '{}');
      const messages = (incoming.messages || []).filter((message) => message.role !== 'system');
      const result = await runOllamaAgent(agentConfig.model || 'llama3.2:1b', agentConfig.prompt, messages, hasSupabase && Boolean(agentConfig.training));
      return send(res, 200, JSON.stringify(result));
    } catch (error) {
      console.error('Falha em /api/chat:', error);
      return send(res, 502, JSON.stringify({ error: `Não foi possível acessar o Ollama: ${error.message}` }));
    }
  }
  if (req.method === 'POST' && req.url === '/api/admin/login') {
    try { const body = await jsonBody(req); if (body.password !== adminPassword) return send(res, 401, JSON.stringify({ error: 'Senha inválida' })); const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, Date.now() + sessionTtlMs); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400` }); return res.end(JSON.stringify({ ok: true, expiresIn: '4h' })); } catch { return send(res, 400, JSON.stringify({ error: 'Requisição inválida' })); }
  }
  if (req.url === '/api/admin/config' && req.method === 'GET') { if (!isAdmin(req)) return unauthorized(res); try { await loadAgentConfig(); return send(res, 200, JSON.stringify({ ...agentConfig, storage: hasSupabase ? 'supabase' : 'sqlite', passwordConfigured: Boolean(process.env.ADMIN_PASSWORD) })); } catch (error) { return send(res, 503, JSON.stringify({ error: error.message })); } }
  if (req.url === '/api/admin/config' && req.method === 'POST') { if (!isAdmin(req)) return unauthorized(res); try { const body = await jsonBody(req); const result = await saveAgentConfig({ prompt: String(body.prompt || ''), training: String(body.training || ''), model: String(body.model || 'llama3.2:1b'), thinking: body.thinking === 'on' ? 'on' : 'off', temperature: Math.min(1, Math.max(0, Number(body.temperature ?? ollamaTemperature))), num_ctx: Math.min(8192, Math.max(1024, Number(body.num_ctx ?? ollamaContext))), num_predict: Math.min(1024, Math.max(64, Number(body.num_predict ?? ollamaPredict))) }); return send(res, 200, JSON.stringify({ ok: true, storage: hasSupabase ? 'supabase' : 'sqlite', embeddings: result.trainingIndexed, indexedChunks: result.indexedChunks })); } catch (error) { return send(res, 400, JSON.stringify({ error: error.message })); } }
  if (req.url === '/api/admin/test' && req.method === 'POST') {
    if (!isAdmin(req)) return unauthorized(res);
    try {
      const body = await jsonBody(req);
      const training = String(body.training || '');
      const savedTraining = hasSupabase && trainingHash(training) === trainingHash(agentConfig.training);
      const prompt = String(body.prompt || '') + (training && !savedTraining ? `\n\nMaterial de teste ainda não indexado:\n${training}` : '');
      const messages = (body.messages || []).filter(message => message.role === 'user' || message.role === 'assistant');
      const result = await runOllamaAgent(String(body.model || agentConfig.model), prompt, messages, savedTraining && Boolean(training), { thinking: body.thinking, temperature: body.temperature });
      return send(res, 200, JSON.stringify(result));
    } catch (error) { return send(res, 502, JSON.stringify({ error: error.message })); }
  }
  if (req.method === 'POST' && req.url === '/api/extract-pdf') {
    try {
      const request = new Request('http://127.0.0.1/api/extract-pdf', { method: 'POST', headers: req.headers, body: req, duplex: 'half' });
      const form = await request.formData();
      const pdfs = [];
      for (const [, value] of form.entries()) if (value && typeof value.arrayBuffer === 'function' && value.name) pdfs.push({ name: value.name, data: Buffer.from(await value.arrayBuffer()) });
      if (pdfs.reduce((sum, file) => sum + file.data.length, 0) > 25 * 1024 * 1024) return send(res, 413, JSON.stringify({ error: 'O PDF excede o limite de 25 MB.' }));
      const extracted = [];
      for (const file of pdfs) extracted.push({ name: file.name, text: await extractPdf(file.data) });
      return send(res, 200, JSON.stringify({ files: extracted }));
    } catch (error) {
      return send(res, 422, JSON.stringify({ error: `Não foi possível extrair o PDF: ${error.message}` }));
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, JSON.stringify({ error: 'Método não permitido' }));
  const requested = req.url === '/admin' ? '/admin.html' : (req.url === '/' || req.url === '/chat' ? '/index.html' : req.url.split('?')[0]);
  const filePath = normalize(join(root, requested));
  if (!filePath.startsWith(root)) return send(res, 403, JSON.stringify({ error: 'Acesso negado' }));
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    res.end(content);
  } catch {
    send(res, 404, JSON.stringify({ error: 'Arquivo não encontrado' }));
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Llama Chat disponível em http://localhost:${port} · banco SQLite: ${dbPath}`));
