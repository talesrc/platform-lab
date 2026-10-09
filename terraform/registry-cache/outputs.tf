output "network_name" {
  description = "Docker network the kind cluster must use."
  value       = docker_network.kind.name
}

output "mirrors" {
  description = "Registry host => mirror endpoint reachable from the kind nodes (consumed by kind-cluster)."
  value = { for host, cache in local.caches :
    host => {
      endpoint = "http://${docker_container.cache[host].name}:5000"
      upstream = cache.upstream
    }
  }
}
