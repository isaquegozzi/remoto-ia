# Remoto IA — Claude Channel (preview)

Este diretório contém uma implementação experimental baseada em **Claude Code Channels**.

Use somente para desenvolvimento enquanto custom Channels exigirem `--dangerously-load-development-channels`.

1. `npm install`
2. copie `.mcp.example.json` para o projeto e ajuste caminho/token;
3. inicie `claude --dangerously-load-development-channels server:remoto-ia`;
4. o Channel sobe em `127.0.0.1:8788`;
5. `POST /` com header `X-Remoto-Token` injeta uma mensagem na sessão;
6. `GET /events` recebe replies e permission requests por SSE;
7. envie `yes abcde` ou `no abcde` por POST para responder a um permission request.
