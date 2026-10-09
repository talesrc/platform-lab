#!/usr/bin/env bash
# Installs Docker Engine natively in this WSL distro (Ubuntu), replacing the
# Docker Desktop WSL integration. Image pulls then use WSL's own network
# instead of Docker Desktop's Windows networking.
set -euo pipefail

DESKTOP_CLI=/mnt/wsl/docker-desktop/cli-tools/usr/bin/docker

# 1. Docker Desktop's WSL integration must be off for this distro, otherwise
#    it keeps re-creating its docker symlinks and socket here. (/mnt/wsl is
#    shared by all distros, so Desktop's mounts there say nothing about this one.)
for f in /usr/bin/docker /bin/docker; do
  if [ -L "$f" ] && [ "$(readlink "$f")" = "$DESKTOP_CLI" ]; then
    echo "Docker Desktop WSL integration is still enabled for this distro ($f -> $DESKTOP_CLI)." >&2
    echo "Disable it: Docker Desktop > Settings > Resources > WSL integration, then Apply & restart." >&2
    exit 1
  fi
done

# 2. Docker's official apt repository.
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

# 3. Engine, CLI and plugins.
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 4. Run as a systemd service and allow docker without sudo.
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

# 5. Drop Docker Desktop's credential helper (desktop.exe), keep the others.
cfg="$HOME/.docker/config.json"
if [ -f "$cfg" ] && grep -q '"credsStore": *"desktop.exe"' "$cfg"; then
  cp "$cfg" "$cfg.bak"
  python3 - "$cfg" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c.pop("credsStore", None)
json.dump(c, open(p, "w"), indent=2)
PY
  echo "Removed credsStore=desktop.exe from $cfg (backup: $cfg.bak)"
fi
docker context use default >/dev/null 2>&1 || true

# 6. Smoke test.
sudo docker run --rm hello-world
echo "Docker Engine is ready: $(docker --version)"
