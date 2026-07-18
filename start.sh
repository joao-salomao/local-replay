#!/usr/bin/env bash
set -euo pipefail
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "")"
if [ -z "$IP" ]; then
  echo "Não achei o IP da rede local; usando localhost (celulares não vão conectar)."
  IP="localhost"
fi
echo "Servidor será acessível em: https://$IP:8443"
HOST_LAN_IP="$IP" exec docker compose up --build
