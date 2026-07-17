# Replay Local — Design

**Data:** 2026-07-17
**Status:** Aprovado no brainstorming; aguardando plano de implementação

## Objetivo

Sistema local de replay esportivo, inspirado no ReplayBR/Gravaê, para uso próprio (hobby) em uma quadra: celulares comuns viram câmeras conectadas a um servidor na rede local; qualquer pessoa aperta um botão "GRAVAR" **depois** que o lance aconteceu e recebe um vídeo combinado dos ângulos na galeria, pronto para baixar e compartilhar. Tudo funciona sem internet — só rede local.

## Decisões de produto (fechadas com o usuário)

| Tema | Decisão |
|---|---|
| Semântica de captura | **Replay retroativo**: buffer contínuo; o botão salva os últimos N segundos |
| Contexto de uso | Uso próprio/hobby — 1 quadra, poucos celulares, sem painel de gestão |
| Câmeras | 2+ celulares filmando; servidor gera **vídeo combinado** dos ângulos (e publica também os ângulos individuais) |
| Botão GRAVAR | Qualquer celular autenticado na rede + um dispositivo dedicado (tablet) — ambos usam a mesma página `/controle` |
| Papel do dispositivo | Ao entrar no sistema, o celular **escolhe o papel**: câmera ou controle |
| Entrega dos vídeos | Galeria local no navegador (`/lances`): assistir, baixar, compartilhar pelo próprio celular |
| Autenticação | **Senha única compartilhada**; qualquer celular na rede pode entrar |
| Servidor | Mac do usuário, **containerizado (Docker)** |
| Runtime | **Bun + TypeScript** (sem framework; `Bun.serve` para HTTP, WebSocket e TLS) |
| Buffer de replay | **Abordagem B — buffer no celular**, upload sob demanda (escolha do usuário, ciente dos trade-offs vs. buffer no servidor) |
| Tamanho do clipe | **Parametrizável em dois níveis**: padrão no `config.json` (20s) + seletor na página `/controle` (10/20/30/45/60s) valendo para os próximos lances |

## Fora de escopo (YAGNI)

Multi-quadra, contas de usuário individuais, upload para nuvem, integração WhatsApp, overlays de patrocinador, transmissão ao vivo, app nativo, placar/scoreboard. Nada disso entra no MVP.

## Arquitetura

```
┌─────────────┐     ┌─────────────┐      ┌───────────────┐
│ Celular A   │     │ Celular B   │      │ Tablet/celular│
│ 📷 /camera  │     │ 📷 /camera  │      │ 🔴 /controle  │
│ filma e     │     │ filma e     │      │ botão GRAVAR  │
│ bufferiza   │     │ bufferiza   │      └───────┬───────┘
└──────┬──────┘     └──────┬──────┘              │
       │   WebSocket (sinais) + HTTPS (uploads)  │
       └──────────────┬────┴─────────────────────┘
                      ▼
        ┌──────────────────────────────┐
        │  Servidor local (Docker/Mac) │
        │  • Bun + TypeScript          │
        │  • Hub WebSocket (papéis)    │
        │  • Fila de processamento     │
        │  • FFmpeg (corte+combinação) │
        │  • Clipes em volume Docker   │
        └──────────────┬───────────────┘
                       ▼
              ┌────────────────┐
              │ 🎬 /lances     │  galeria: assistir,
              │ qualquer       │  baixar, compartilhar
              │ celular        │
              └────────────────┘
```

### As 4 páginas

1. **`/` (entrada):** pede a senha, cria sessão, oferece os papéis: **"Ser câmera"** e **"Controlar gravação"**, mais link para a galeria.
2. **`/camera`:** transforma o celular em câmera fixa (tripé): preview, buffer rolante, aguarda sinal GRAVAR via WebSocket. Mostra status (conectado / bufferizando / enviando). A pessoa nomeia o ângulo ("Fundo", "Lateral rede"...) — persiste em `localStorage`.
3. **`/controle`:** botão GRAVAR gigante + seletor de duração do clipe (10/20/30/45/60s) + lista de câmeras online + status do último lance (capturando → processando → pronto) + QR code de entrada no sistema.
4. **`/lances`:** galeria dos clipes (mais recente primeiro), player, download, QR code por clipe.

### Fluxo de um lance (fim a fim)

1. Celulares A e B em `/camera`, filmando e bufferizando localmente.
2. Alguém aperta GRAVAR em `/controle` → servidor registra timestamp `T` (relógio do servidor), cria o **job do lance** e publica `GRAVAR(jobId, T, janela)` para todas as câmeras online.
3. Cada câmera finaliza o trecho em andamento e faz upload dos arquivos do buffer que cobrem `[T − janela, T]`, com metadados.
4. Servidor valida uploads; quando todas as câmeras online entregam (ou estoura timeout de 30s), o job entra na fila.
5. Worker processa com FFmpeg: corta cada ângulo na janela exata, normaliza, monta o combinado.
6. Clipe aparece em `/lances`; `/controle` notifica "Lance pronto".

## Página câmera — buffer rolante no celular

**Captura.** `getUserMedia` (câmera traseira, 1080p@30fps, fallback 720p) + `MediaRecorder` com chunks de 1s. Áudio capturado por padrão.

**Buffer rolante por ciclos.** Chunks de `MediaRecorder` só são decodáveis a partir do início do arquivo, então o esquema é: reiniciar o gravador a cada **ciclo** e manter em memória o **arquivo do ciclo anterior (completo) + o atual (crescendo)**. Cobertura garantida = 1 ciclo inteiro, mesmo logo após um reinício.

- **Ciclo = max(30s, janela configurada).** Quando a janela muda no `/controle`, o servidor retransmite às câmeras, que aplicam no próximo ciclo. Isso limita o upload ao pior caso de 2× o ciclo por câmera.
- Teto da janela: **60s** (mantém memória ≤ ~90–135 MB em 1080p ~6 Mbps). Janela maior exigiria subir o teto na configuração — suportado pelo design, custa memória do celular.
- No reinício de ciclo há um micro-gap (~100–300ms), no máximo 1× por ciclo; se cair dentro da janela, vira uma emenda quase imperceptível (servidor concatena os dois arquivos).

**Ao receber `GRAVAR(jobId, T, janela)`:** a página **para o gravador atual** (finaliza o arquivo de forma limpa em todas as plataformas — mais confiável que `requestData()`) e já inicia o próximo ciclo; seleciona os arquivos que cobrem `[T − janela, T]`; sobe via `POST /api/lances/:id/upload` (multipart) com metadados: nome do ângulo, horário de início de cada arquivo (em relógio do servidor), mimetype/codec. Retry de upload: 3 tentativas com backoff. O gap do reinício fica **depois** de `T`, fora do clipe.

**Tela sempre acesa.** Wake Lock API impede o descanso de tela. Instrução de operação: celular no tripé, **na tomada**, página em primeiro plano. Em `visibilitychange` (aba escondida), a página marca-se degradada; ao voltar, alerta e reinicia o buffer. O hub marca a câmera offline se o heartbeat parar.

**Relógio sincronizado.** No connect do WebSocket, handshake NTP simplificado (3 pings → offset mediano; precisão típica <100ms em LAN). Re-sync a cada reconexão e a cada 5 min. Todo arquivo do buffer é etiquetado com horário **do servidor**. Precisão de alinhamento entre ângulos: ±100–200ms (suficiente para replay; alinhamento frame-accurate está fora de escopo).

**Compatibilidade.** Android Chrome ≥ 96 (WebM/VP8-VP9-H.264) e iOS Safari ≥ 16.4 (MP4/H.264; 16.4 é o piso por causa do Wake Lock). O servidor aceita ambos os formatos e normaliza na saída.

## Servidor

**Responsabilidades:** servir páginas estáticas; autenticar; manter o hub WebSocket (registro de câmeras com nome/status e controles, heartbeat 5s, NTP); coordenar jobs de lance; processar com FFmpeg; servir a galeria e os arquivos.

**Job de lance:**
1. Trigger cria job (id sequencial, `T`, janela vigente) e responde imediatamente ao controle.
2. Publica `GRAVAR` no tópico das câmeras; aguarda uploads com **timeout de 30s**. Câmera que não entregar fica de fora — lance com 1 ângulo é válido.
3. Uploads validados (cobrem a janela?) e anexados ao job.
4. Job completo (ou timeout) → **fila de processamento**, 1 job por vez (não saturar o Mac).
5. Cooldown de 2s entre triggers (anti duplo-toque). Lances em sequência são permitidos — o buffer do celular não se esgota; os jobs enfileiram.

**Pipeline FFmpeg (por job):**
- Por ângulo: concatenar os 2 arquivos se houver emenda de ciclo → corte exato em `[T − janela, T]` usando o horário de início do arquivo (seek preciso com re-encode) → normalizar para H.264/AAC MP4 (1080p, áudio do próprio ângulo).
- Combinado, conforme layout configurado:
  - **`sequencia`** (padrão): ângulos um após o outro, corte seco.
  - **`lado-a-lado`**: ângulos juntos na tela; áudio do primeiro ângulo.
- Saída: combinado + ângulos individuais, todos publicados na galeria.
- Falha num ângulo (arquivo corrompido): publica os válidos, registra o erro em `meta.json`, loga detalhe.

**Armazenamento (sem banco de dados):**
```
data/
├── config.json          # senha, janela padrão, layout, resolução, retenção, teto da janela
├── certs/               # certificado autoassinado (gerado no 1º boot)
└── clips/2026-07-17/lance-042/
    ├── combinado.mp4
    ├── angulo-fundo.mp4
    ├── angulo-lateral.mp4
    └── meta.json        # T, janela, câmeras, layout, duração, erros parciais
```
A galeria lista lendo o diretório. Volume Docker mapeia `data/` para uma pasta do Mac. Retenção: `retencao_dias` no config — `null` por padrão (manter tudo); se definido, clipes mais antigos que o valor são apagados na inicialização e 1× por dia.

**Configuração dinâmica:** a janela vigente (seletor do `/controle`) é estado do servidor, persistido em `config.json`, retransmitido a câmeras e controles ao mudar.

## Autenticação e rede

- **Senha compartilhada** no `config.json`. Login → cookie de sessão assinado, HttpOnly, validade 24h. Rotas de API e upgrade de WebSocket validam o cookie. Rate limit: 5 tentativas/min por IP.
- **HTTPS obrigatório** (requisito do `getUserMedia`): certificado autoassinado gerado no 1º boot (openssl no container), persistido no volume. Cada celular aceita o aviso do navegador uma vez. Porta 8443 (HTTPS); porta 8080 apenas redireciona para HTTPS.
- **Entrada fácil:** `start.sh` detecta o IP do Mac na LAN, injeta como env var no compose e imprime QR code da URL no terminal; `/controle` também exibe o QR.

## Tratamento de erros

| Situação | Comportamento |
|---|---|
| Câmera perde Wi-Fi / aba suspensa | Heartbeat 5s → marcada offline no `/controle`; ao voltar, reconecta e reinicia buffer sozinha |
| GRAVAR sem câmeras online | Botão desabilitado com aviso |
| Upload falha | 3 retries com backoff; timeout de 30s do job segue com os ângulos recebidos |
| FFmpeg falha num ângulo | Publica ângulos válidos; erro em `meta.json` e log |
| Duplo toque no GRAVAR | Cooldown de 2s no servidor |
| Disco < 5 GB | Aviso em `/controle` e `/lances` |
| Drift de relógio | Re-sync NTP a cada reconexão e a cada 5 min |

## Testes

- **Unitários (`bun test`):** seleção de arquivos do buffer para uma janela; cálculo de offset NTP; montagem de comandos FFmpeg; validação de uploads.
- **Integração:** pipeline FFmpeg com vídeos sintéticos (`testsrc`) — corte, concat, combinação; validação com `ffprobe` (duração, streams). Roda no container, sem celular.
- **Simulador de câmera:** script que se conecta como câmera e envia vídeo sintético — fluxo inteiro (2 câmeras fake + trigger + galeria) sem hardware.
- **Checklist de quadra:** 2 celulares na tomada, wake lock ativo, 5 lances, conferência na galeria, teste de queda de Wi-Fi de uma câmera.

## Critérios de sucesso (MVP)

1. Com 2 celulares reais + 1 controle na rede local: apertar GRAVAR produz o clipe combinado com a duração configurada, visível na galeria em ≤ 60s.
2. Ajustar a duração no `/controle` vale para o lance seguinte.
3. Uma câmera cai → lance sai com o ângulo restante; a câmera reconecta sozinha ao voltar.
4. Sistema opera sem internet (rede local pura) após o build da imagem.

## Estrutura do projeto (proposta)

```
replaybr/
├── docker-compose.yml
├── Dockerfile               # oven/bun + ffmpeg
├── start.sh                 # detecta IP da LAN, sobe compose, imprime QR
├── package.json
├── src/
│   ├── server/
│   │   ├── index.ts         # Bun.serve: rotas, estáticos, TLS
│   │   ├── auth.ts          # senha, sessão, rate limit
│   │   ├── hub.ts           # WebSocket: papéis, heartbeat, NTP
│   │   ├── lance.ts         # jobs: trigger, coleta de uploads, timeout
│   │   ├── queue.ts         # fila de processamento (1 por vez)
│   │   ├── ffmpeg.ts        # corte, concat, combinação, probe
│   │   ├── storage.ts       # clips/, meta.json, listagem, espaço em disco
│   │   └── config.ts        # config.json (inclui janela vigente)
│   └── web/
│       ├── index.html + login.ts
│       ├── camera/          # buffer rolante, wake lock, upload
│       ├── controle/        # botão, seletor de duração, status, QR
│       ├── lances/          # galeria, player, download, QR por clipe
│       └── shared/          # cliente WS, NTP, API
├── tests/
│   ├── unit/
│   ├── integration/
│   └── simulator/           # câmera fake
└── data/                    # volume (gitignored): config, certs, clips
```

## Notas de performance

Dentro do Docker no Mac, o FFmpeg codifica por software (a VM Linux não acessa o media engine do Apple Silicon) — estimativa de ~15–30s de processamento por lance de 2 ângulos × 20s. Se precisar de mais velocidade no futuro, rodar fora do container (`bun` nativo + `ffmpeg` do brew, com VideoToolbox) fica 5–10× mais rápido; o design funciona idêntico nos dois modos.
