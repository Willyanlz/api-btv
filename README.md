# Universal Remote API

API Node.js/TypeScript com SQLite e driver ADB restrito a operações permitidas.

## Recursos

- Autenticação JWT sem expiração automática.
- CRUD de dispositivos, macros e comandos permitidos.
- Execução sequencial de macros com variáveis.
- Aplicativo esperado opcional por macro, com verificação do app em primeiro plano e espera de 3 segundos após abri-lo.
- Erros de macro informam o número exato do passo, a macro e a causa original.
- Bloqueio de execuções simultâneas por dispositivo.
- Composição de macros com proteção contra referências circulares.
- Teste de um passo ou de um intervalo de passos da macro.
- Reconexão ADB antes de cada operação.
- Screenshot remoto em `GET /api/v1/devices/:id/screenshot` sem cache.
- Conexões ADB já autorizadas são reutilizadas para acelerar screenshots e comandos.
- Diagnóstico conjunto da rota Tailscale, disponibilidade do aparelho e autorização ADB.
- Consulta, ativação e desativação verificadas do Tailscale como VPN sempre ativa.
- Listagem de apps de usuário com `pm list packages -3`.
- Nome e ícone real extraídos do APK e armazenados no SQLite por dispositivo.
- APK usado na extração é temporário e removido imediatamente após o processamento.
- O cache só processa pacotes novos; entradas de aplicativos desinstalados são removidas automaticamente.
- Ícones PNG/WebP são servidos por rota autenticada; ícones adaptativos ou incompatíveis usam fallback visual.
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

Um endereço IP da rede local pode ser cadastrado quando o servidor que executa a
API consegue alcançá-lo. Como a API de produção roda em uma VPS, endereços
privados como `192.168.x.x` exigem Tailscale, VPN site-to-site ou um agente dentro
da residência. A porta ADB 5555 não deve ser publicada diretamente na internet.
