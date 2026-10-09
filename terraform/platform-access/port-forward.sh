#!/usr/bin/env bash
# Terraform `external` data source: start a detached, self-terminating
# `kubectl port-forward` to a Service and return its local URL as JSON.
# Input (stdin JSON): kubeconfig, namespace, service, port, lifetime (seconds).
set -euo pipefail

eval "$(python3 -c 'import json,shlex,sys; [print(f"{k}={shlex.quote(str(v))}") for k,v in json.load(sys.stdin).items()]')"

local_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')

# setsid + nohup: survive this script; timeout: never outlive the Terraform run for long.
setsid nohup timeout "${lifetime}" kubectl --kubeconfig "${kubeconfig}" -n "${namespace}" \
  port-forward "svc/${service}" "${local_port}:${port}" >/dev/null 2>&1 < /dev/null &

for _ in $(seq 1 50); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${local_port}") 2>/dev/null; then
    printf '{"url":"http://127.0.0.1:%s"}\n' "${local_port}"
    exit 0
  fi
  sleep 0.2
done
echo "port-forward to ${namespace}/svc/${service} did not come up" >&2
exit 1
