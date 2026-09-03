# Universal Remote API

API Node.js/TypeScript com SQLite e driver ADB restrito a operações permitidas.

## Recursos

- Autenticação JWT sem expiração automática.
- CRUD de dispositivos, macros e comandos permitidos.
- Execução sequencial de macros com variáveis.
- Reconexão ADB antes de cada operação.
- Listagem de apps de usuário com `pm list packages -3`.
- Exclusão adicional de pacotes `com.amazon.*` e `amazon.*`.
- Abertura com `monkey`, desinstalação com `adb uninstall` e instalação de APK com `adb install -r`.
- APK temporário excluído da VPS após a tentativa de instalação.

## Desenvolvimento

Copie `.env.example` para `.env` e execute:

```bash
npm install
npm run build
npm start
```

Produção: API em `127.0.0.1:3000`, Nginx na porta 80 e Cloudflare Tunnel em `https://box.labswill.com`.
