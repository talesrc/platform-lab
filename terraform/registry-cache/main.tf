locals {
  # registry host => container name, e.g. "docker.io" => "registry-cache-docker-io"
  caches = { for host, url in var.upstreams : host => {
    name     = "registry-cache-${replace(host, ".", "-")}"
    upstream = url
  } }
}

# Created here (not by kind) so the caches can join it before the cluster exists;
# kind reuses a network that already has its name. It survives `kind delete`.
resource "docker_network" "kind" {
  name   = var.network_name
  driver = "bridge"
  options = {
    "com.docker.network.bridge.enable_ip_masquerade" = "true"
    "com.docker.network.driver.mtu"                  = "1500"
  }
}

resource "docker_image" "registry" {
  name         = "${var.registry_image}:${var.registry_image_tag}"
  keep_locally = true
}

# Cached layers live in volumes, so they survive cluster rebuilds and container replacement.
resource "docker_volume" "cache" {
  for_each = local.caches
  name     = each.value.name
}

resource "docker_container" "cache" {
  for_each = local.caches

  name    = each.value.name
  image   = docker_image.registry.image_id
  restart = "unless-stopped"

  env = [
    "REGISTRY_PROXY_REMOTEURL=${each.value.upstream}",
    "REGISTRY_PROXY_TTL=${var.cache_ttl}",
  ]

  volumes {
    volume_name    = docker_volume.cache[each.key].name
    container_path = "/var/lib/registry"
  }

  networks_advanced {
    name = docker_network.kind.name
  }
}
