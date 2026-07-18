# Replay Local

Sistema local de replay esportivo para uso próprio (hobby) em uma quadra: celulares comuns viram
câmeras conectadas a um servidor na rede local. Depois que um lance acontece, qualquer pessoa
aperta **GRAVAR** e recebe, na galeria, um vídeo combinado dos ângulos — pronto para assistir,
baixar e compartilhar. Tudo roda na rede local, sem depender de internet durante o uso (só na
hora de montar a imagem Docker).

## Sumário

- [Requisitos](#requisitos)
- [Como iniciar](#como-iniciar)
- [Como usar](#como-usar)
- [Conectando cada aparelho](#conectando-cada-aparelho)
- [Configuração](#configuração)
- [Rodando na internet (atrás de um proxy)](#rodando-na-internet-atrás-de-um-proxy)
- [Desenvolvimento](#desenvolvimento)
- [Checklist de quadra](#checklist-de-quadra)
- [Nota de performance](#nota-de-performance)
- [Estrutura dos dados](#estrutura-dos-dados)
- [Solução de problemas](#solução-de-problemas)

## Requisitos

- **Docker** (recomendado) — Docker Desktop, OrbStack ou qualquer engine compatível com
  `docker compose`. É só isso; o container já traz Bun, FFmpeg e OpenSSL.
- **Ou, para rodar sem container:** [Bun](https://bun.sh) 1.x + `ffmpeg` + `openssl` no PATH da
  máquina.
- Um Mac (ou outra máquina) na mesma rede Wi-Fi dos celulares que vão filmar.

## Como iniciar

```bash
./start.sh
```

O script detecta o IP da sua máquina na rede local, sobe o `docker compose` (buildando a imagem
na primeira vez) e imprime no terminal a URL de entrada junto com um **QR code**. Aponte a câmera
de cada celular para o QR do terminal (ou digite a URL manualmente) para abrir o sistema.

Na **primeira execução**, o servidor gera automaticamente uma senha de acesso e a grava em
`data/config.json`; a senha também é impressa no terminal junto com a URL, logo abaixo do QR
code. Guarde-a — ela não muda entre reinícios, só é gerada uma vez. Se precisar vê-la de novo mais
tarde: `docker compose logs replay | grep Senha`, ou abra `data/config.json` e leia o campo
`"password"`.

Para parar: `Ctrl+C` no terminal onde o `start.sh` está rodando, ou `docker compose down` em outro
terminal. Os dados (config, certificado, clipes) ficam persistidos em `./data` no host graças ao
volume do `docker-compose.yml` — subir de novo com `./start.sh` não perde nada.

## Como usar

Ao abrir a URL, cada aparelho digita a senha e escolhe um papel:

- **📷 Ser câmera** — transforma o celular em câmera fixa. Dê um nome ao ângulo (ex: "Fundo",
  "Lateral rede"), monte o celular num tripé, **deixe-o na tomada** e mantenha a página em
  primeiro plano durante toda a sessão (a página mostra um aviso e recupera sozinha o buffer se a
  aba for escondida ou o sistema operacional pausar a câmera em segundo plano).
- **🔴 Controlar gravação** — a página de controle: botão **GRAVAR** grande, seletor de duração do
  clipe (10/20/30/45/60s), lista das câmeras online com a resolução/fps ao vivo de cada uma,
  status do último lance (capturando → processando → pronto) e um QR code para outros aparelhos
  entrarem. Pode ser usada por qualquer celular autenticado ou por um tablet dedicado.
- **🎬 Ver lances** — a galeria (`/clips`): lista os clipes mais recentes primeiro, com player,
  links de download (combinado + cada ângulo individual), botão **📤 Compartilhar** (abre o menu
  nativo de compartilhamento do celular, com fallback para download em navegadores sem essa API)
  e um QR code por clipe apontando direto para o arquivo de vídeo.

**Fluxo de um lance:** as câmeras ficam conectadas, filmando e bufferizando os últimos segundos
localmente. Quando alguém aperta GRAVAR em `/control`, o servidor registra o instante `T`, cria um
job e avisa todas as câmeras online. Cada câmera termina o trecho em andamento e envia os arquivos
do buffer que cobrem a janela `[T − duração, T]`. O servidor aguarda os uploads (até 30s — quem não
entregar fica de fora do lance, ele ainda sai com os ângulos restantes), processa com FFmpeg
(corte exato, normalização, combinação dos ângulos) e o clipe aparece em `/clips`; `/control`
mostra "Lance pronto".

## Conectando cada aparelho

O certificado HTTPS é autoassinado (necessário para a câmera do navegador funcionar), então cada
aparelho precisa aceitar um aviso de segurança uma vez.

**iPhone (use o Safari):**
1. Abra a URL no Safari e toque em "Continuar" (ou "Avançado → Visitar este site") no aviso de
   segurança.
2. Se a página carregar mas a conexão em tempo real (WebSocket) não completar — câmera presa em
   "Desconectado" — o aviso do navegador não foi suficiente. Baixe o certificado em `/cert` (tem
   um atalho na própria tela de login, em "Problemas para conectar no iPhone?") e instale:
   **Ajustes → Geral → VPN e Gerenciamento de Dispositivo** (instalar o perfil baixado), depois
   **Ajustes → Geral → Sobre → Confiança de Certificado** (ativar a confiança para o certificado).

**Android (use o Chrome):** toque em **"Avançado → Continuar"** no aviso do navegador. Isso já é
suficiente, inclusive para o WebSocket.

**Em ambos os aparelhos:**
- Desligue a economia/otimização de bateria para o navegador durante a sessão — ela pode suspender
  a página e derrubar a câmera.
- Deixe o celular na tomada e à sombra: calor prolongado derruba o fps e a qualidade da captura em
  ambas as plataformas.
- 60fps é **melhor esforço do navegador** — vários aparelhos (inclusive iPhones) entregam 30fps
  mesmo pedindo 60 como ideal. A página `/camera` mostra a resolução/fps reais obtidos, atualizados
  a cada 5s; a saída final do servidor é conformada para a resolução/fps alvo (padrão 1080p60,
  ajustável em `targetHeight`/`targetFps`) independente da fonte.

## Configuração

Editável em `data/config.json` no host (pare o container, edite, suba de novo — o arquivo só é
lido na inicialização, exceto `clipDurationSeconds`, que também pode ser trocado ao vivo pelo
seletor em `/control`, sem precisar mexer no arquivo nem reiniciar):

| Chave | Padrão | Descrição |
|---|---|---|
| `clipDurationSeconds` | `20` | Duração do clipe (segundos) usada no **próximo** lance. Também ajustável ao vivo em `/control`. |
| `clipDurationMaxSeconds` | `60` | Teto aceito para `clipDurationSeconds` (o servidor rejeita valores maiores). |
| `bufferCycleMinSeconds` | `30` | Duração mínima do ciclo de buffer de cada câmera. O ciclo real usado é `max(bufferCycleMinSeconds, clipDurationSeconds)`. |
| `layout` | `"sequential"` | `"sequential"` (ângulos em sequência, corte seco) ou `"side-by-side"` (ângulos lado a lado na tela, áudio do primeiro ângulo). |
| `targetHeight` | `1080` | Altura alvo (px) da saída normalizada. |
| `targetFps` | `60` | FPS alvo da saída normalizada. |
| `retentionDays` | `null` | Dias para manter clipes. `null` = manter tudo para sempre. Se definido, a limpeza roda na inicialização e depois 1×/dia. |

O arquivo também guarda `password` (gerada automaticamente no primeiro boot — veja
[Como iniciar](#como-iniciar)).

**Variáveis de ambiente** (já configuradas pelo `docker-compose.yml`/`start.sh`; só mexa se for
rodar fora do Docker ou mudar as portas padrão):

| Variável | Padrão | Descrição |
|---|---|---|
| `DATA_DIR` | `data` | Pasta onde ficam `config.json`, `certs/` e `clips/`. |
| `HTTPS_PORT` | `8443` | Porta HTTPS — é a porta de entrada do sistema. |
| `HTTP_PORT` | `8080` | Porta HTTP; só responde com redirect 301 para a HTTPS. |
| `HOST_LAN_IP` | *(vazio)* | IP da máquina na rede local, usado no certificado (SAN) e na URL impressa no boot. O `start.sh` já detecta e injeta esse valor sozinho. |

## Rodando na internet (atrás de um proxy)

Por padrão o Replay Local roda em **modo LAN** (tudo acima): HTTPS autoassinado, pensado para uso
dentro da rede Wi-Fi de uma quadra. Se quiser expor o sistema na internet — por exemplo, um evento
em que nem todo mundo consegue entrar na mesma rede — dá para rodar em **modo proxy**: o Bun serve
HTTP puro numa porta interna, e um proxy reverso na frente (Caddy, nginx, Cloudflare Tunnel etc.)
cuida do TLS com um certificado de verdade.

**Variáveis de ambiente do modo proxy** (além das já existentes; `HTTPS_PORT`/`HTTP_PORT`/
`HOST_LAN_IP` da tabela acima são ignoradas nesse modo):

| Variável | Padrão | Descrição |
|---|---|---|
| `BEHIND_PROXY` | *(vazio)* | Ativa o modo proxy quando definida como `1`, `true` ou `yes` (case-insensitive; ex.: `BEHIND_PROXY=1`) — qualquer outro valor, incluindo vazio, `false` ou `0`, mantém o modo LAN padrão. Nesse modo desliga a geração do certificado autoassinado e o redirect HTTP→HTTPS; o servidor passa a escutar HTTP puro em `PORT`. |
| `PUBLIC_URL` | *(vazio)* | Endereço público servido pelo proxy (ex.: `https://replay.exemplo.com`), usado na mensagem de boot e no QR code do terminal. **Se não for definida, o servidor sobe mesmo assim, mas avisa no terminal** que o QR/link vai apontar para `localhost` e não vai funcionar nos aparelhos dos jogadores. |
| `PORT` | `8080` | Porta HTTP pura em que o app escuta, para o proxy encaminhar as requisições. |

Com `BEHIND_PROXY` ativo, o IP usado para limitar tentativas de login (rate limit) passa a vir do
cabeçalho `X-Forwarded-For` — a **última** entrada da lista, não a primeira, pois é essa que reflete
o peer observado diretamente pelo proxy da borda; entradas anteriores vêm do próprio cliente e podem
ser forjadas — em vez do IP do socket (nesse modo o socket é sempre o do proxy, não o do cliente).
Qualquer proxy reverso comum já define esse cabeçalho com o IP real do cliente por padrão (veja a
Nota de segurança abaixo para o cuidado necessário com a porta `PORT`).

### Exemplo com Caddy

O [Caddy](https://caddyserver.com) provisiona certificado Let's Encrypt automaticamente para o
domínio configurado e já encaminha WebSocket sem nenhuma configuração extra (diferente do nginx,
que exige os headers `Upgrade`/`Connection` manualmente). Um `Caddyfile` mínimo:

```
replay.exemplo.com {
    reverse_proxy localhost:8080
}
```

Suba o app com `BEHIND_PROXY=1 PUBLIC_URL=https://replay.exemplo.com PORT=8080` no ambiente (veja
a nota de Docker abaixo) e rode o Caddy na mesma máquina (ou num container ao lado) apontando para
essa mesma porta.

### Docker

No `docker-compose.yml`, publique só a porta HTTP (quem fica público é o proxy, não o app) e passe
as três variáveis nesse serviço:

```yaml
services:
  replay:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./data:/app/data
    environment:
      - BEHIND_PROXY=1
      - PUBLIC_URL=https://replay.exemplo.com
      - PORT=8080
    restart: unless-stopped
```

### Nota de segurança

Sendo honesto: o único obstáculo entre um desconhecido na internet e as câmeras/clipes desse
sistema é a **senha compartilhada** guardada em `data/config.json`. Não existe conta por pessoa,
convite ou lista de permissões — quem tem a senha (ou consegue adivinhar) vê tudo. Isso é aceitável
para uso doméstico numa rede fechada (modo LAN), mas expor na internet muda o cálculo de risco.
Recomendações mínimas antes de expor publicamente:

- Troque a senha gerada automaticamente por uma forte (edite o campo `password` em
  `data/config.json` antes de subir, ou pare o container, edite e suba de novo).
- Sirva **só** HTTPS — é isso que o proxy da seção acima já garante; não exponha a porta `PORT`
  (HTTP puro) diretamente para a internet, apenas o proxy deve ser público.
- O rate limit de login confia na **última** entrada do `X-Forwarded-For` (o peer observado
  diretamente pelo proxy da borda) — seguro com Caddy (descarta o XFF recebido do cliente), nginx
  (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, que só anexa) e Cloudflare
  (idem, append-only). Isso só é seguro se a porta `PORT` não estiver exposta direto à internet
  (bullet acima) — do contrário um cliente pode falar direto com o app e forjar o XFF livremente.
- Para um evento privado, considere também restringir por IP na frente, no proxy — por exemplo, no
  Caddy, com um matcher `remote_ip` bloqueando quem não estiver na lista esperada — em vez de
  depender só da senha.

As instruções de modo LAN (rede local, sem proxy) continuam valendo normalmente e são o padrão sem
nenhuma variável nova — veja [Como iniciar](#como-iniciar) e [Configuração](#configuração). O modo
proxy é só opt-in via `BEHIND_PROXY`.

## Desenvolvimento

```bash
bun install       # instala as dependências
bun run dev       # sobe o servidor local (bun run src/server/index.ts) — exige ffmpeg/openssl no PATH
bun test          # roda a suíte unit + integration (tests/unit e tests/integration)
bun run test:e2e  # Playwright: fluxo completo num Chromium com câmera fake
bun run format    # aplica a formatação do Biome no projeto (biome format --write .)
```

> **Nota honesta sobre o e2e:** `bun run test:e2e` precisa de um navegador Chromium real com
> suporte a `--use-fake-device-for-media-stream` completando a captura de mídia fake — isso
> funciona de forma confiável em CI Linux padrão (ex.: GitHub Actions `ubuntu-latest`), mas nem
> todo ambiente sandboxed/headless consegue completar esse handshake de câmera (observado em
> alguns sandboxes macOS). Se `#conn-text` ficar travado em "Desconectado" e o teste estourar por
> timeout na etapa de câmera, é esse limite do ambiente — não um defeito do app. Rode em uma
> máquina/CI onde a câmera fake realmente é concedida para validar o fluxo ponta a ponta.

## Checklist de quadra

Validação manual recomendada antes de contar com o sistema num jogo de verdade:

- [ ] 2 celulares (câmeras) na tomada
- [ ] Wake lock ativo em cada câmera — tela acesa, sem apagar durante a sessão
- [ ] 5 lances gravados em sequência
- [ ] Conferência de todos os 5 na galeria (`/clips`) — combinado + ângulos individuais abrem e
      tocam
- [ ] Teste de queda de Wi-Fi de uma câmera: desligar o Wi-Fi de um aparelho no meio da sessão,
      confirmar que ela some da lista em `/control`, e que um lance gravado nesse intervalo ainda
      sai (com o ângulo restante); reativar o Wi-Fi e confirmar que a câmera reconecta sozinha

## Nota de performance

Dentro do Docker no Mac, o FFmpeg codifica **por software** — a VM Linux do Docker não acessa o
media engine do Apple Silicon. Em 1080p60, um lance de 2 ângulos × 20s leva cerca de **30–60s**
para processar. Se precisar de mais velocidade, rode fora do container: `bun run dev` nativo (com
`ffmpeg` do Homebrew, que usa VideoToolbox) fica **5–10× mais rápido** — o comportamento é
idêntico nos dois modos, só muda a velocidade de encoding.

## Estrutura dos dados

Tudo em `data/` (volume mapeado pelo `docker-compose.yml`; sem banco de dados):

```
data/
├── config.json           # senha, duração do clipe, layout, resolução/fps alvo, retenção
├── session-secret        # chave usada para assinar o cookie de sessão
├── certs/                 # certificado autoassinado (gerado no 1º boot; regenerado se HOST_LAN_IP mudar)
│   ├── cert.pem
│   └── key.pem
└── clips/2026-07-17/clip-042/
    ├── combined.mp4
    ├── angle-fundo.mp4     # nome do ângulo vem do apelido dado na câmera (slugificado)
    ├── angle-lateral.mp4
    └── meta.json           # T, janela, câmeras, layout, duração, erros parciais
```

## Solução de problemas

| Situação | Comportamento esperado |
|---|---|
| Câmera perde Wi-Fi / aba suspensa | Some da lista em `/control` em ~10s (heartbeat a cada 3s, considerada offline após 10s sem sinal); ao voltar, reconecta e reinicia o buffer sozinha |
| GRAVAR sem nenhuma câmera online | Botão fica desabilitado, com aviso |
| Upload de uma câmera falha | 3 tentativas com backoff; o lance ainda fecha com os ângulos que chegaram dentro do timeout de 30s |
| FFmpeg falha num ângulo | Publica os ângulos que deram certo; erro registrado em `meta.json` e no log do servidor |
| Disco com menos de 5 GB livres | Aviso aparece em `/control` e `/clips` |
| Duplo toque em GRAVAR | Cooldown de 2s no servidor evita lance duplicado |
