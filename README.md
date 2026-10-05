# Remoto IA

Interface web para comar agentes de código (Codex e Claude Code) a partir do celular. O agente roda no computador, usando o ambiente real dele; o celular é só o controle.

A ideia é simples: o celular não executa uma versão reduzida do agente. Ele se conecta ao Codex ou ao Claude Code que já estão instalados no PC e manda instruções para eles.

## Estado atual

Protótipo funcional. O caminho principal com Codex está completo. Com Claude Code, o caminho por CLI funciona, mas as aprovações que dependem de interação ainda não são resolvidas.

| Área | Situação |
|---|---|
| Codex | Completo: App Server real, login por device code, threads, envio, fila, steer, interrupção, streaming e aprovação |
| Claude Code | Funciona por CLI: verificação de login, sessão persistida, retomada, streaming e interrupção. **Aprovação remota no modo CLI não funciona** |
| Claude Channel | Base experimental em research preview, não é o caminho principal |
| Transporte | Host local e relay WebSocket funcionando. **Relay não tem autenticação multiusuário** |

Dois itens estão declarados como pendentes no próprio projeto:

- **Aprovação remota do Claude no modo CLI.** O endpoint responde HTTP 501 e manda usar o Channel preview.
- **Autenticação multiusuário de produção no relay.**

O repositório está na versão 2.0.0.

## O que mudou em relação à V1

A V1 era uma ponte direta entre o navegador e o PC, com o host escutando em `0.0.0.0` (acessível na rede local), `Access-Control-Allow-Origin: *`, pareamento por código de 6 dígitos com validade de 1 hora e WebSocket direto do navegador para o host.

A V2 mudou a arquitetura:

- o host passou a escutar **somente `127.0.0.1`**;
- o CORS passou a usar **lista de origens permitidas**, em vez de `*`;
- o acesso do navegador passou a ser **HTTP com SSE** no modo local, em vez de WebSocket direto;
- foi introduzido um **relay WebSocket opcional**, para o celular alcançar o PC fora da rede local;
- o pareamento passou a usar um **token longo** em vez de código de 6 dígitos;
- `localhost` foi resolvido no código, com um botão desabilitado que explica que no celular `localhost` é o próprio celular.

Importante: a V2 **não substituiu** o acesso local direto. Ela o restringiu a `127.0.0.1` e adicionou o relay como caminho opcional. Os dois convivem na interface, como **Host Local** e **Relay Web**.

## Funcionalidades implementadas

### Host

O `bridge.js` é um servidor HTTP em Node puro, sem framework. Ele também serve o frontend estático. Rotas:

| Rota | O que faz |
|---|---|
| `GET /api/status` | Situação do host, do Codex e do Claude |
| `POST /api/codex/login/device` | Inicia o login por device code |
| `GET /api/threads` | Lista sessões (Codex ou Claude, conforme `agent`) |
| `POST /api/threads` | Cria sessão |
| `GET /api/thread` | Lê uma sessão com o histórico |
| `POST /api/message` | Envia a instrução |
| `POST /api/interrupt` | Interrompe o turno em andamento |
| `POST /api/approval` | Responde a uma aprovação do Codex |
| `GET /api/events` | Stream de eventos (SSE) |

### Adaptadores dos agentes

**Codex** — sobe `codex app-server` e fala JSON-RPC por stdio. Faz o handshake `initialize` e usa `account/read`, `account/login/start`, `thread/list`, `thread/start`, `thread/read`, `turn/start`, `turn/steer` e `turn/interrupt`. Tem fila local por thread: se já existe um turno ativo, a nova mensagem espera e é disparada sozinha quando o anterior termina.

**Claude Code** — executa `claude -p` com saída `stream-json` e mensagens parciais. Guarda o `session_id` que vem no stream e usa `--resume` nos turnos seguintes. Interromper é terminar o processo local.

### Relay

Servidor WebSocket em `relay/relay-server.js`, usando a biblioteca `ws`. O PC **abre a conexão para fora**, então não é preciso abrir porta no roteador. O handshake exige `hostId` e um token com pelo menos 32 caracteres. Requisições vão do navegador para o host; respostas e eventos voltam para todos os navegadores do mesmo host.

### Interface web

Página única em HTML, CSS e JavaScript sem build, pensada para celular. Tem abas separadas para Codex e Claude, indicador de status do host, login por device code, verificação do Claude, teste de conexão, filtro de tarefas, criação de sessão com a pasta do projeto, histórico da conversa, streaming ao vivo, indicação de uso de ferramenta, botão de parar, aprovação do Codex com negar/aprovar, seletor de modelo do Claude e alternância entre tema claro e escuro.

O modo **Sequência** enfileira a mensagem; o modo **Steer** manda a orientação para o turno já em andamento. Ambos são do Codex.

### Parcial

- **Aprovação do Claude no modo CLI** devolve HTTP 501.
- **Claude Channel** (`claude-channel/`) é uma implementação experimental baseada em Claude Code Channels. Expõe uma ferramenta `reply` e encaminha pedidos de permissão. Exige a flag `--dangerously-load-development-channels` no Claude Code, ou seja, é research preview.

## Tecnologias

- **Node.js 20 ou superior** (`engines` no `package.json`).
- **Sem framework.** Não há Express, React, bundler nem transpilador. O frontend é HTML, CSS e JavaScript puro servido como arquivo estático.
- **Única dependência de runtime:** `ws` (`^8.18.3`, resolvida em 8.21.3), usada no relay.
- **JSON-RPC 2.0 por stdio** para falar com o Codex App Server.
- **SSE** (Server-Sent Events) para o stream de eventos no modo local.
- **WebSocket** para o relay.
- **MCP** (Model Context Protocol) no `claude-channel/`, com `@modelcontextprotocol/sdk ^1.17.4` e `zod ^3.25.76`.

## Como executar

### Requisitos no PC

- Windows 10 ou 11. O código tem ramificação para Linux e macOS, mas o README original diz "conceitualmente" nesses sistemas: **o caminho testado e documentado é Windows.**
- Node.js 20+
- Codex CLI instalado e disponível como `codex`
- Claude Code instalado e disponível como `claude`

Confira antes:

```bash
node --version
codex --version
claude --version
claude auth status
```

### Instalação

```bash
npm install
npm run host
```

No Windows há também `START-HOST.bat`, que instala as dependências se necessário e sobe o host. `START-RELAY.bat` faz o mesmo pelo relay.

Os scripts disponíveis são:

```bash
npm run host     # node bridge.js
npm run relay    # node relay/relay-server.js
npm run check    # valida a sintaxe de 7 arquivos JavaScript
```

O host imprime o identificador da máquina, a URL local e o pairing token:

```text
REMOTO IA V2 — HOST REAL
Host: DESKTOP-XXXX
Local: http://127.0.0.1:8081
Pairing token: 7c...<token longo>...
```

Abra `http://127.0.0.1:8081` no próprio PC, entre em **Config**, deixe **Host Local**, cole o token e clique em **Salvar**.

### Variáveis de ambiente

**Não existe carregador de `.env`.** Não há `dotenv` no projeto, então um arquivo `.env` não é lido automaticamente. As variáveis precisam ser exportadas no shell.

| Variável | Para que serve | Padrão |
|---|---|---|
| `REMOTO_PORT` | Porta do host local | `8081` |
| `REMOTO_PAIRING_TOKEN` | Token de pareamento. Se vazio, o host gera um e mostra no terminal | gerado automaticamente |
| `REMOTO_ALLOWED_ORIGINS` | Origens permitidas para acesso direto ao host, separadas por vírgula | — |
| `REMOTO_RELAY_URL` | Endereço `wss://` do relay. Se definida, ativa o relay no host | desligado |
| `REMOTO_HOST_ID` | Identificador do host no relay | `os.hostname()` |
| `PORT` | Porta do relay | `8787` |
| `REMOTO_CLAUDE_CHANNEL_PORT` | Porta HTTP do Channel | `8788` |
| `REMOTO_CLAUDE_CHANNEL_TOKEN` | Token do header `X-Remoto-Token` do Channel | — |

No PowerShell:

```powershell
$env:REMOTO_RELAY_URL="wss://relay.seudominio.com"
$env:REMOTO_HOST_ID="MEU-PC"
npm run host
```

### Relay

```bash
npm install
npm run relay
```

O `relay-server.js` serve apenas WebSocket puro (`ws://`). **O TLS não está implementado no código**: o serviço escuta em `0.0.0.0` e é preciso colocar um proxy com HTTPS/TLS na frente para obter uma URL `wss://`.

No celular, informe em **Config > Relay Web**: a URL `wss://`, o Host ID e o mesmo pairing token mostrado pelo host.

O frontend pode ser hospedado estaticamente na Vercel. O `vercel.json` aqui não configura nenhuma função serverless: ele só liga `cleanUrls` e dois cabeçalhos de segurança (`X-Content-Type-Options: nosniff` e `Referrer-Policy: no-referrer`). O relay precisa de um serviço Node com suporte a WebSocket de longa duração.

## Como usar

Fluxo do primeiro uso:

1. No PC: `npm install` e `npm run host`. Guarde o pairing token.
2. No navegador do próprio PC: abra `http://127.0.0.1:8081`, cole o token em **Config** e salve.
3. **Codex**: clique em **Login ChatGPT/Codex por Device Code**. O host devolve a URL de verificação e o código; complete o login oficial e clique em **Atualizar**.
4. **Claude**: o host roda `claude auth status`. Se não estiver autenticado, rode `claude auth login` e reinicie o host.
5. Crie uma tarefa informando a pasta do projeto no PC.
6. Escreva a instrução e envie. Com Codex, escolha antes **Sequência** (enfileira) ou **Steer** (manda para o turno ativo).
7. Acompanhe o streaming, use **Parar** para interromper e responda **Negar** ou **Aprovar** quando o Codex pedir.

Para acessar de fora da rede local, use o relay. Não tente apontar a página hospedada para `localhost:8081`: no celular, `localhost` é o próprio celular.

## Organização do projeto

| Arquivo ou pasta | Responsabilidade |
|---|---|
| `bridge.js` | O host: HTTP, SSE, aprovação e conexão com o relay |
| `lib/codex-app-server.js` | Cliente JSON-RPC do `codex app-server` |
| `lib/claude-cli.js` | Driver do `claude -p` e leitura do stream |
| `lib/state-store.js` | Persistência do token e das sessões em `.remoto-state.json` |
| `relay/relay-server.js` | Relay WebSocket, para rodar no servidor público |
| `relay/relay-client.js` | Cliente WebSocket do host, com reconexão |
| `claude-channel/` | Channel MCP experimental para o Claude Code |
| `index.html`, `app.js`, `styles.css` | A interface web |
| `START-HOST.bat`, `START-RELAY.bat` | Atalhos de inicialização no Windows |
| `vercel.json` | Configuração de hospedagem do frontend |

## Limitações e pendências

**Defeitos e limitações conhecidos:**

- O modo Claude por CLI **não tem fila nem steer**. Se a sessão já está executando, enviar outra mensagem retorna um erro pedindo que a execução seja interrompida primeiro. Isso vale para o Codex não.
- Aprovações que dependem de interação são limitadas no modo não-interativo do Claude.
- O relay serve `ws://` puro, sem TLS, escuta em todas as interfaces e tem o endpoint de status HTTP público, sem autenticação.
- O relay exige apenas `hostId` e um token de no mínimo 32 caracteres. Não há contas, rate limiting nem expiração de sessão.
- Um único token dá acesso a **todos** os agentes do host. Não há separação por usuário.
- O pairing token é impresso em texto claro no terminal e gravado em texto claro em `.remoto-state.json`. No modo relay ele trafega dentro do JSON do WebSocket, e o token do SSE vai na query string. O frontend o guarda no `localStorage`.
- Existem funções vazias no frontend: `toggleProjectMenu()`, `closeDiffModal()` e `togglePasswordVisibility()`. `openOptionsModal()` é apenas um apelido para a interrupção, e `generateNewPairingCode()` só mostra um aviso.
- A pasta do projeto é digitada em um `prompt()` do navegador, sem seletor de projeto.
- A interface oferece duas decisões de aprovação, embora o backend aceite quatro.
- O método `thread/resume` existe no adaptador do Codex mas não é exposto em nenhuma rota.

**Funcionalidade ainda não implementada:**

- Aprovação remota do Claude no modo CLI.
- Autenticação multiusuário de produção no relay.

## Próximos passos

Todos os itens abaixo estão na lista de segurança do próprio projeto, antes de o relay ser disponibilizado publicamente:

- TLS obrigatório;
- conta de usuário ou OIDC;
- identidade criptográfica persistente do host;
- rotação e revogação de dispositivos;
- rate limiting;
- expiração de sessão;
- logs de auditoria;
- proteção contra replay;
- armazenamento seguro de credenciais no servidor;
- isolamento entre usuários e hosts.

Mais os dois itens pendentes de status: a aprovação remota do Claude no modo CLI e a autenticação multiusuário do relay.

## Testes

**Não há testes automatizados.** Não existe suíte, framework nem pasta de testes no projeto, nem no V2 nem na V1.

A única verificação disponível é a validação de sintaxe:

```bash
npm run check
```

Esse comando roda `node --check` sobre sete arquivos JavaScript (`bridge.js`, `app.js`, os três módulos de `lib/` e os dois de `relay/`). Ele detecta erro de sintaxe, mas não executa nada e não verifica comportamento.

## Segurança

O relay incluído é um protótipo de desenvolvimento, não um serviço pronto para produção.

O host escuta apenas em `127.0.0.1`. **Não exponha a porta 8081 diretamente na Internet.**

Nunca publique `.env.local`, `.git`, tokens de hospedagem, chaves OpenAI/Anthropic ou o arquivo `.remoto-state.json`. Esse último já está no `.gitignore` e é criado no primeiro uso do host.

## Licença

MIT. Ver `LICENSE`.