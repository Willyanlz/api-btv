# Universal Remote API

API Node.js/TypeScript com SQLite e driver ADB seguro. Copie `.env.example` para `.env`, defina os segredos e execute `npm install && npm run build && npm start`.

O processo deve executar como usuário sem privilégios. Somente ações ADB previamente autorizadas são expostas.

## Produção atual

A API executa internamente em `127.0.0.1:3000`, passa pelo Nginx na porta 80 e é publicada com TLS pelo Cloudflare Tunnel em `https://box.labswill.com`.
