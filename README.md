# Universal Remote API

API Node.js/TypeScript com SQLite e driver ADB restrito a operações permitidas.

## Recursos

- Autenticação JWT sem expiração automática.
- CRUD de dispositivos, macros e comandos permitidos.
- Execução sequencial de macros com variáveis.
- Aplicativo esperado opcional por macro, com verificação do app em primeiro plano e espera configurável de 0 a 60 segundos (10 segundos por padrão) após abri-lo.
- Erros de macro informam o número exato do passo, a macro e a causa original.
- Bloqueio de execuções simultâneas por dispositivo.
- Composição de macros com proteção contra referências circulares.
- Teste de um passo ou de um intervalo de passos da macro.
- Condição por tela conhecida com caminhos independentes; o catálogo começa pela **Tela de busca** do UniTV.
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

## Reinstalação em outro servidor Ubuntu

Pré-requisitos: Ubuntu 22.04/24.04, Node.js 20+, ADB, `aapt`, `unzip`, Nginx e
uma rota de rede entre o servidor e os aparelhos Android.

```bash
sudo apt update
sudo apt install -y adb aapt unzip nginx build-essential
git clone https://github.com/Willyanlz/api-btv.git
cd api-btv
npm ci
npm run build
tar --exclude=node_modules --exclude=.git -czf /tmp/backend-deploy.tgz .
sudo bash deploy/install.sh /tmp/backend-deploy.tgz
```

O instalador cria o usuário restrito `remote-api`, os diretórios
`/opt/universal-remote-api` e `/var/lib/universal-remote-api`, o serviço systemd
e um arquivo de ambiente inicial. Consulte a senha gerada uma única vez:

```bash
cat ~/INITIAL_ADMIN_PASSWORD
```

Revise `/etc/universal-remote-api.env`, instale `deploy/nginx.conf` como site do
Nginx e publique a porta HTTP por um proxy HTTPS de sua preferência. Nunca
publique a porta ADB `5555` diretamente na internet.

### Backup e restauração

O estado persistente fica no SQLite indicado por `DATABASE_PATH` (em produção,
`/var/lib/universal-remote-api/app.db`). Faça um backup consistente com:

```bash
sudo sqlite3 /var/lib/universal-remote-api/app.db ".backup '/tmp/app-backup.db'"
```

Para restaurar, pare o serviço, substitua o banco, corrija o proprietário e
inicie novamente:

```bash
sudo systemctl stop universal-remote-api
sudo install -o remote-api -g remote-api -m 600 app-backup.db /var/lib/universal-remote-api/app.db
sudo systemctl start universal-remote-api
```

O arquivo `/etc/universal-remote-api.env` contém segredos e deve ser recriado ou
armazenado separadamente em um cofre; não o envie ao GitHub. A interface web está
no repositório `https://github.com/Willyanlz/app-btv` e precisa apontar
`environment.apiUrl` para a nova URL HTTPS da API.

Produção: API em `127.0.0.1:3000`, Nginx na porta 80 e Cloudflare Tunnel em `https://box.labswill.com`.

Um endereço IP da rede local pode ser cadastrado quando o servidor que executa a
API consegue alcançá-lo. Como a API de produção roda em uma VPS, endereços
privados como `192.168.x.x` exigem Tailscale, VPN site-to-site ou um agente dentro
da residência. A porta ADB 5555 não deve ser publicada diretamente na internet.
