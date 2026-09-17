#!/usr/bin/env bash
set -euo pipefail
echo 'Add a direct host in Paseo Desktop: 127.0.0.1:6768.'
echo 'Get the password in your own terminal: kubectl --context docker-desktop -n paseo-system get secret paseo-identity -o jsonpath="{.data.password}" | base64 --decode'
exec kubectl --context docker-desktop --namespace paseo-system port-forward --address 127.0.0.1 service/paseo-gateway 6768:8080
