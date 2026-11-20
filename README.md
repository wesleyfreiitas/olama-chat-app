# Sofia — agente de onboarding

Aplicação web local para configurar e testar um agente de IA com prompt, histórico de conversa e uma base de conhecimento pesquisável. O Ollama gera as respostas; o Supabase pode armazenar a configuração e os embeddings.

## Começar

Requisitos:

- Node.js com suporte a `node:sqlite` (use uma versão recente, como Node 22.13 ou posterior).
- Ollama em execução, localmente ou em um servidor acessível.
- Um modelo de conversa e, para busca semântica, `nomic-embed-text`.
- Para importar PDFs, Python com o pacote `pypdf`.
- Opcionalmente, um projeto Supabase com pgvector configurado pelo arquivo `supabase-schema.sql`.

Exemplo no PowerShell:

```powershell
cd "C:\Users\User\Documents\ChatGPT\Olama"
ollama pull qwen3:4b
ollama pull nomic-embed-text
node server.mjs
```

Acesse [o painel administrativo](http://localhost:3000/admin) ou [o chat](http://localhost:3000/chat). O servidor escuta apenas em `127.0.0.1`; a porta padrão é 3000. Para parar, pressione `Ctrl+C` no terminal.

## Configuração

Crie um arquivo `.env` na raiz. Não publique esse arquivo nem compartilhe a chave secreta do Supabase.

```env
PORT=3000
ADMIN_PASSWORD=escolha-uma-senha
OLLAMA_URL=http://127.0.0.1:11434/api/chat
EMBEDDING_MODEL=nomic-embed-text
OLLAMA_TEMPERATURE=0.3
OLLAMA_NUM_CTX=4096
OLLAMA_NUM_PREDICT=256
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SECRET_KEY=sua-chave-secreta
PDF_PYTHON=C:\caminho\para\python.exe
```

`SUPABASE_SERVICE_ROLE_KEY` também é aceita no lugar de `SUPABASE_SECRET_KEY`. Essas chaves são exclusivamente do servidor. Sem senha configurada, uma senha temporária é gerada e exibida no terminal. Sem `OLLAMA_URL`, o código usa um endereço remoto antigo: configure explicitamente o endpoint desejado. `PDF_PYTHON` deve apontar para um Python que tenha `pypdf` instalado; o padrão atual aponta para um caminho específico de uma instalação Windows.

No admin é possível editar modelo, prompt, material, temperatura e modo de raciocínio. O teste usa os valores atuais dos campos, mesmo antes de salvar. O chat público usa a configuração salva no servidor.

## Como funciona

1. O navegador envia a mensagem e o histórico para `/api/chat` ou, no teste administrativo, `/api/admin/test`.
2. O servidor envia o prompt configurado como mensagem de sistema e o histórico de usuário e assistente ao Ollama.
3. Com material indexado no Supabase, o modelo pode chamar a ferramenta de busca; o servidor executa a busca e devolve os resultados ao modelo para formular a resposta.
4. No teste administrativo, material alterado e ainda não indexado é enviado como contexto diretamente. A conversa do navegador permanece apenas na sessão atual.

O arquivo `onboarding-flow.json` permanece como referência, mas não é usado na conversa. O comportamento é definido pelo prompt do administrador. O sistema não garante que o modelo siga todas as instruções.

## Material e busca semântica

No admin, cole texto ou adicione arquivos TXT, Markdown, CSV, JSON, HTML e PDF. O PDF precisa ter texto extraível; não há OCR implementado. Os arquivos são incorporados ao campo de texto e salvos como uma base principal, não como documentos gerenciados separadamente.

Com Supabase configurado, o servidor divide o texto em trechos, gera embeddings via Ollama e grava vetores de 768 dimensões em `training_chunks`. A função `match_training_chunks` retorna os trechos semanticamente próximos para auxiliar respostas. O modelo de embedding precisa ser compatível com essa dimensão. A busca atual não aplica filtro de setor na consulta vetorial, mesmo quando o setor é informado: revise isso antes de confiar no isolamento entre setores.

## Persistência e limites

`supabase-schema.sql` define `agent_config`, `training_material`, `training_chunks`, `conversations`, `messages` e a função de busca vetorial. A configuração e a base principal são usadas pelo servidor; a existência das tabelas de conversas e mensagens não significa que o progresso do roteiro seja persistido nelas.

Se o Supabase falhar na inicialização, o processo passa a usar `llama-chat.sqlite` local. Ele não reconecta automaticamente: reinicie o servidor após restabelecer a conexão. Os dados locais e remotos são independentes; confira a origem antes de salvar alterações. As sessões de admin ficam em memória e são perdidas ao reiniciar. O cookie administrativo expira em quatro horas.

O histórico é enviado pelo navegador, mas o tamanho efetivo de contexto do modelo é limitado por `num_ctx`; conversas longas podem exceder esse limite. O comportamento e o conteúdo devem ser validados com conversas reais antes de uso operacional.

## Arquivos principais

- `server.mjs`: servidor HTTP, autenticação, comunicação com Ollama e Supabase, extração de PDF e busca vetorial.
- `index.html`: interface do chat.
- `admin.html` e `admin.js`: painel de configuração e teste.
- `onboarding-flow.json`: roteiro anterior, preservado como referência e não carregado pelo agente.
- `supabase-schema.sql`: esquema de referência do Supabase.
- `agent-config.json`: configuração legada utilizada como fallback na inicialização quando o SQLite ainda não possui configuração.

## Diagnóstico

- **`fetch failed`**: verifique a URL do Ollama e a conexão com o Supabase; consulte o terminal para identificar qual chamada falhou.
- **Modelo não encontrado**: confira `ollama list` e o nome exato no painel.
- **Erro de alocação de memória**: experimente um modelo menor ou reduza o contexto; arquivo de modelo e memória de execução têm tamanhos diferentes.
- **Configuração antiga no admin**: verifique se o servidor iniciou em SQLite. Após recuperar o Supabase, reinicie e procure `Persistência: Supabase` no terminal.
- **PDF não extraído**: confira `PDF_PYTHON`, a instalação de `pypdf` e se o PDF contém texto selecionável.
