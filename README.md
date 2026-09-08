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
- Espelhamento ao vivo baseado em scrcpy, com vídeo H.264 e controle por toque.
- Sessões de espelhamento usam tickets curtos e cookie seguro; o serviço scrcpy
  não fica exposto diretamente à rede.
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

## Pacote Docker isolado

O arquivo `compose.yml` executa a API e um sidecar Tailscale exclusivo do projeto.
ADB, AAPT, Node.js, SQLite e o estado da tailnet ficam dentro do pacote; nenhuma
dessas dependências precisa ser instalada no host. Somente a porta
`127.0.0.1:3100` é publicada para o Cloudflare Tunnel existente.

Diretórios persistentes:

- `data/`: banco SQLite.
- `adb-keys/`: chaves de autorização ADB.

As chaves ADB ficam persistidas fora do container. Recriar ou atualizar o
serviço não gera uma identidade nova. Chaves recuperadas de instalações
anteriores podem ser colocadas em `adb-keys/legacy/`; o backend tentará essas
identidades também, preservando aparelhos que já haviam sido autorizados.

O diretório `scrcpy-data/` mantém as dependências e configurações próprias do
espelhamento. O vídeo usa `https://box.labswill.com/mirror`, no mesmo Cloudflare
Tunnel já configurado. O backend valida o ticket e encaminha HTTP/WebSocket
internamente; nenhuma porta adicional é publicada.
- `tailscale-state/`: identidade da conta Tailscale exclusiva.
- `tailscale-run/`: socket interno compartilhado somente entre a API e o Tailscale do projeto.

Inicialização:

```bash
cp .env.container.example .env
docker compose up -d --build
docker compose exec tailscale-box tailscale up --hostname=box-labswill --accept-dns=false
```

Abra o link mostrado pelo último comando usando a conta Tailscale destinada às
TVs. Configure o Cloudflare Tunnel geral para encaminhar `box.labswill.com` para
`http://localhost:3100`.

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
