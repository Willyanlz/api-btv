# Universal Remote API

API Node.js/TypeScript com SQLite e driver ADB seguro. Copie `.env.example` para `.env`, defina os segredos e execute `npm install && npm run build && npm start`.

O processo deve executar como usuário sem privilégios. Somente ações ADB previamente autorizadas são expostas.

O token da primeira versão não expira automaticamente, atendendo ao uso doméstico simplificado. Ele é invalidado quando o segredo do serviço é trocado.

## Produção atual

A API executa internamente em `127.0.0.1:3000`, passa pelo Nginx na porta 80 e é publicada com TLS pelo Cloudflare Tunnel em `https://box.labswill.com`.

## Fluxo de uso

1. Cadastre um dispositivo com o IP ou hostname do Tailscale e a porta ADB.
2. Cadastre aplicativos usando o nome real do pacote Android.
3. Monte macros com `GET /api/v1/actions`; o cliente nunca envia ADB arbitrário.
4. Execute uma macro com `POST /api/v1/devices/:deviceId/macros/:macroId/run`.

Macros podem definir `requiresInput`, `inputLabel` e `inputVariable`. O frontend coleta o valor antes da execução e envia em `variables`; o motor substitui expressões como `{{texto}}` nos passos de digitação.

Os recursos `devices`, `apps`, `macros`, `intents` e `automations` possuem operações de listagem, criação, atualização e exclusão em `/api/v1`. Uma instalação nova retorna listas vazias; nenhum dado demonstrativo é inserido.
