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
const hasSupabase = Boolean(supabaseUrl && supabaseKey);
const sessions = new Map();
let agentConfig = { prompt: 'Você é um assistente útil, claro e direto. Responda sempre em português do Brasil. Se não souber algo, diga que não sabe.', training: '', model: 'llama3.2:1b' };
const configRows = db.prepare('SELECT key, value FROM agent_config').all();
if (!configRows.length) { try { const legacy = JSON.parse(await readFile(configPath, 'utf8')); agentConfig = { ...agentConfig, ...legacy }; } catch {} }
for (const row of configRows) agentConfig[row.key] = row.value;
async function supabaseRequest(path, options = {}) { const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) } }); if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${await response.text()}`); return response.status === 204 ? null : response.json(); }
async function loadAgentConfig() { if (!hasSupabase) return agentConfig; const rows = await supabaseRequest('agent_config?select=key,value'); for (const row of rows) if (row.key !== 'training') agentConfig[row.key] = row.value; const material = await supabaseRequest('training_material?select=content&active=eq.true&order=updated_at.desc&limit=1'); if (material[0]) agentConfig.training = material[0].content; return agentConfig; }
async function saveAgentConfig(next) { agentConfig = next; if (hasSupabase) { await supabaseRequest('agent_config?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ key: 'prompt', value: agentConfig.prompt }, { key: 'model', value: agentConfig.model }]) }); await supabaseRequest('training_material?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ id: 1, title: 'Base principal do agente', content: agentConfig.training, source: 'painel admin', active: true, updated_at: new Date().toISOString() }]) }); } else { const save = db.prepare('INSERT INTO agent_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'); for (const [key, value] of Object.entries(agentConfig)) save.run(key, value); } }
if (hasSupabase) { try { await loadAgentConfig(); console.log('Persistência: Supabase.'); } catch (error) { console.error(`Supabase indisponível; usando SQLite: ${error.message}`); } }
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      if (hasSupabase) await loadAgentConfig();
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const incoming = JSON.parse(raw || '{}');
      const context = agentConfig.training ? `${agentConfig.prompt}\n\n=== BASE DE CONHECIMENTO ===\n${agentConfig.training}\n=== FIM DA BASE ===\n\nUse a base acima como fonte principal. Não invente informações que contradigam o material.` : agentConfig.prompt;
      const messages = (incoming.messages || []).filter((message) => message.role !== 'system');
      const upstream = await fetch(ollamaUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: agentConfig.model || incoming.model || 'llama3.2:1b', messages: [{ role: 'system', content: context }, ...messages], stream: false }) });
      return send(res, upstream.status, await upstream.text());
    } catch (error) {
      return send(res, 502, JSON.stringify({ error: `Não foi possível acessar o Ollama: ${error.message}` }));
    }
  }
  if (req.method === 'POST' && req.url === '/api/admin/login') {
    try { const body = await jsonBody(req); if (body.password !== adminPassword) return send(res, 401, JSON.stringify({ error: 'Senha inválida' })); const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, Date.now() + sessionTtlMs); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400` }); return res.end(JSON.stringify({ ok: true, expiresIn: '4h' })); } catch { return send(res, 400, JSON.stringify({ error: 'Requisição inválida' })); }
  }
  if (req.url === '/api/admin/config' && req.method === 'GET') { if (!isAdmin(req)) return unauthorized(res); try { await loadAgentConfig(); return send(res, 200, JSON.stringify({ ...agentConfig, storage: hasSupabase ? 'supabase' : 'sqlite', passwordConfigured: Boolean(process.env.ADMIN_PASSWORD) })); } catch (error) { return send(res, 503, JSON.stringify({ error: error.message })); } }
  if (req.url === '/api/admin/config' && req.method === 'POST') { if (!isAdmin(req)) return unauthorized(res); try { const body = await jsonBody(req); await saveAgentConfig({ prompt: String(body.prompt || ''), training: String(body.training || ''), model: String(body.model || 'llama3.2:1b') }); return send(res, 200, JSON.stringify({ ok: true, storage: hasSupabase ? 'supabase' : 'sqlite' })); } catch (error) { return send(res, 400, JSON.stringify({ error: error.message })); } }
  if (req.url === '/api/admin/test' && req.method === 'POST') { if (!isAdmin(req)) return unauthorized(res); try { const body = await jsonBody(req); const prompt = String(body.prompt || ''); const training = String(body.training || ''); const context = training ? `${prompt}\n\n=== BASE DE CONHECIMENTO ===\n${training}\n=== FIM DA BASE ===\n\nUse a base acima como fonte principal. Não invente informações que contradigam o material.` : prompt; const upstream = await fetch(ollamaUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: String(body.model || 'llama3.2:1b'), messages: [{ role: 'system', content: context }, ...(body.messages || []).filter((message) => message.role !== 'system')], stream: false }) }); return send(res, upstream.status, await upstream.text()); } catch (error) { return send(res, 502, JSON.stringify({ error: error.message })); } }
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
