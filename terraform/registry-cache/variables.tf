variable "docker_host" {
  description = "Docker daemon the caches (and the kind cluster) run on."
  type        = string
  default     = "unix:///var/run/docker.sock"
}

variable "network_name" {
  description = "Docker network shared with the kind nodes. kind reuses an existing network with this name (its default is \"kind\")."
  type        = string
  default     = "kind"
}

variable "registry_image" {
  description = "Image of the CNCF Distribution registry, run in pull-through proxy mode."
  type        = string
  default     = "registry"
}

variable "registry_image_tag" {
  description = "Tag of registry_image."
  type        = string
  # renovate: datasource=docker depName=registry
  default = "3.1.2"
}

variable "upstreams" {
  description = "Registries to cache: registry host as seen in image references => upstream URL."
  type        = map(string)
  default = {
    "docker.io"       = "https://registry-1.docker.io"
    "quay.io"         = "https://quay.io"
    "registry.k8s.io" = "https://registry.k8s.io"
    "ghcr.io"         = "https://ghcr.io"
  }
}

variable "cache_ttl" {
  description = "How long cached content is kept before it is re-checked upstream (Distribution proxy TTL)."
  type        = string
  default     = "168h"
}
