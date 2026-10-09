output "network_name" {
  description = "Docker network the kind cluster must use."
  value       = docker_network.kind.name
}

output "mirrors" {
  description = "Registry host => mirror endpoint reachable from the kind nodes (consumed by kind-cluster)."
  value = merge(
    { for host, cache in local.caches :
      host => {
        endpoint = "http://${docker_container.cache[host].name}:5000"
        upstream = cache.upstream
      }
    },
    # Aliases pull through the target's cache and fall back to their own host.
    { for alias, target in var.aliases :
      alias => {
        endpoint = "http://${docker_container.cache[target].name}:5000"
        upstream = "https://${alias}"
      }
    },
  )
}
