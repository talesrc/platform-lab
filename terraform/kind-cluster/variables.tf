variable "cluster_name" {
  description = "Name of the kind cluster."
  type        = string
  default     = "platform-lab"

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", var.cluster_name))
    error_message = "cluster_name must be a lowercase RFC 1123 name (letters, digits, '-')."
  }
}

variable "kubernetes_version" {
  description = "Kubernetes version, i.e. the kindest/node image tag (see https://hub.docker.com/r/kindest/node/tags)."
  type        = string
  default     = "v1.37.0"

  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+$", var.kubernetes_version))
    error_message = "kubernetes_version must look like v1.37.0."
  }
}

variable "node_image_repository" {
  description = "Repository of the kind node image; override for a mirror or private registry."
  type        = string
  default     = "kindest/node"
}

variable "node_image_digest" {
  description = "Optional sha256 digest pinning the node image (kind recommends it; see the kind release notes). null = tag only."
  type        = string
  default     = null

  validation {
    condition     = var.node_image_digest == null || can(regex("^sha256:[a-f0-9]{64}$", var.node_image_digest))
    error_message = "node_image_digest must look like sha256:<64 hex chars>."
  }
}

variable "control_plane_count" {
  description = "Number of control-plane nodes (use 1 or 3 for HA)."
  type        = number
  default     = 1

  validation {
    condition     = var.control_plane_count >= 1
    error_message = "At least one control-plane node is required."
  }
}

variable "worker_count" {
  description = "Number of worker nodes."
  type        = number
  default     = 2

  validation {
    condition     = var.worker_count >= 0
    error_message = "worker_count cannot be negative."
  }
}

variable "worker_labels" {
  description = "Labels applied to every worker node."
  type        = map(string)
  default     = {}
}

variable "ingress_ready" {
  description = "Label the first control-plane node 'ingress-ready=true' and map host ports for an ingress controller."
  type        = bool
  default     = true
}

variable "ingress_node_ports" {
  description = "NodePorts (30000-32767) the ingress/gateway Service exposes; they are mapped to ingress_host_ports."
  type = object({
    http  = number
    https = number
  })
  default = {
    http  = 30080
    https = 30443
  }

  validation {
    condition     = alltrue([for p in values(var.ingress_node_ports) : p >= 30000 && p <= 32767])
    error_message = "ingress_node_ports must be within the NodePort range 30000-32767."
  }
}

variable "ingress_host_ports" {
  description = "Host ports mapped to ingress_node_ports on the first control-plane node when ingress_ready is true."
  type = object({
    http  = number
    https = number
  })
  default = {
    http  = 80
    https = 443
  }
}

variable "networking" {
  description = "Cluster networking settings."
  type = object({
    api_server_address  = optional(string, "127.0.0.1")
    api_server_port     = optional(number, 6443)
    pod_subnet          = optional(string, "10.244.0.0/16")
    service_subnet      = optional(string, "10.96.0.0/12")
    disable_default_cni = optional(bool, false)
    kube_proxy_mode     = optional(string, "iptables")
  })
  default = {}

  validation {
    condition     = contains(["iptables", "ipvs", "nftables", "none"], var.networking.kube_proxy_mode)
    error_message = "kube_proxy_mode must be one of iptables, ipvs, nftables, none."
  }
}

variable "feature_gates" {
  description = "Kubernetes feature gates to enable/disable cluster-wide."
  type        = map(bool)
  default     = {}
}

variable "kubeconfig_path" {
  description = "File to write the kubeconfig to. null = <module dir>/kubeconfig."
  type        = string
  default     = null
}

variable "wait_timeout" {
  description = "How long `kind create cluster` waits for the control plane to be ready (e.g. 5m). \"0s\" = don't wait."
  type        = string
  default     = "5m"
}

variable "kind_binary" {
  description = "kind CLI to run (needs v0.32+ for Kubernetes 1.36+)."
  type        = string
  default     = "kind"
}
