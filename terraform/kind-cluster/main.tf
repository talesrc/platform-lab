# Optional pull-through registry caches (terraform/registry-cache).
data "terraform_remote_state" "registry_cache" {
  count   = var.registry_cache_state_path == null ? 0 : 1
  backend = "local"
  config = {
    path = var.registry_cache_state_path
  }
}

locals {
  kubeconfig_path = abspath(coalesce(var.kubeconfig_path, "${path.module}/kubeconfig"))

  registry_mirrors = try(data.terraform_remote_state.registry_cache[0].outputs.mirrors, {})
  docker_network   = try(data.terraform_remote_state.registry_cache[0].outputs.network_name, "kind")
  # containerd hosts.toml files, one dir per registry, mounted into every node.
  registry_hosts_dir = abspath("${path.module}/.containerd-certs.d")
  registry_mounts = length(local.registry_mirrors) == 0 ? [] : [{
    extraMounts = [{
      hostPath      = local.registry_hosts_dir
      containerPath = "/etc/containerd/certs.d"
      readOnly      = true
    }]
  }]

  node_image = join("@", compact([
    "${var.node_image_repository}:${var.kubernetes_version}",
    var.node_image_digest,
  ]))

  control_plane_nodes = [
    for i in range(var.control_plane_count) : merge(
      { role = "control-plane" },
      concat(
        # Only the first control-plane node receives ingress traffic.
        [for ingress in [{
          labels = { "ingress-ready" = "true" }
          extraPortMappings = [
            { containerPort = var.ingress_node_ports.http, hostPort = var.ingress_host_ports.http, protocol = "TCP" },
            { containerPort = var.ingress_node_ports.https, hostPort = var.ingress_host_ports.https, protocol = "TCP" },
          ]
        }] : ingress if var.ingress_ready && i == 0],
        local.registry_mounts,
      )...
    )
  ]

  worker_nodes = [
    for i in range(var.worker_count) : merge(
      { role = "worker" },
      concat(
        [for labels in [var.worker_labels] : { labels = labels } if length(labels) > 0],
        local.registry_mounts,
      )...
    )
  ]

  # https://kind.sigs.k8s.io/docs/user/configuration/
  kind_config = yamlencode(merge(
    {
      kind       = "Cluster"
      apiVersion = "kind.x-k8s.io/v1alpha4"
      networking = {
        apiServerAddress  = var.networking.api_server_address
        apiServerPort     = var.networking.api_server_port
        podSubnet         = var.networking.pod_subnet
        serviceSubnet     = var.networking.service_subnet
        disableDefaultCNI = var.networking.disable_default_cni
        kubeProxyMode     = var.networking.kube_proxy_mode
      }
      nodes = concat(local.control_plane_nodes, local.worker_nodes)
    },
    {
      # Applied to every node's kubelet.
      kubeadmConfigPatches = [yamlencode(merge(
        {
          apiVersion = "kubelet.config.k8s.io/v1beta1"
          kind       = "KubeletConfiguration"
        },
        var.max_parallel_image_pulls > 1 ? {
          serializeImagePulls   = false
          maxParallelImagePulls = var.max_parallel_image_pulls
        } : { serializeImagePulls = true, maxParallelImagePulls = 1 },
      ))]
    },
    concat(
      [for gates in [var.feature_gates] : { featureGates = gates } if length(gates) > 0],
      # Make containerd read per-registry mirror config from /etc/containerd/certs.d.
      [for patch in [<<-TOML
        [plugins."io.containerd.grpc.v1.cri".registry]
          config_path = "/etc/containerd/certs.d"
      TOML
      ] : { containerdConfigPatches = [patch] } if length(local.registry_mirrors) > 0],
    )...
  ))
}

# https://github.com/containerd/containerd/blob/main/docs/hosts.md
resource "local_file" "registry_hosts" {
  for_each = local.registry_mirrors

  filename        = "${local.registry_hosts_dir}/${each.key}/hosts.toml"
  file_permission = "0644"
  content         = <<-TOML
    server = "${each.value.upstream}"

    [host."${each.value.endpoint}"]
      capabilities = ["pull", "resolve"]
  TOML
}

# kind cannot modify a running cluster, so any change to the inputs below
# replaces it (delete + create).
resource "terraform_data" "cluster" {
  input = {
    name            = var.cluster_name
    image           = local.node_image
    config          = local.kind_config
    kubeconfig_path = local.kubeconfig_path
    kind_binary     = var.kind_binary
    docker_network  = local.docker_network
    # Mirror config must be on disk before the nodes mount it.
    registry_hosts = { for host, f in local_file.registry_hosts : host => f.content }
  }

  triggers_replace = [var.cluster_name, local.node_image, local.kind_config, local.kubeconfig_path, local.docker_network]

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      printf '%s' "$KIND_CONFIG" | "$KIND" create cluster \
        --name "$CLUSTER_NAME" \
        --image "$NODE_IMAGE" \
        --kubeconfig "$KUBECONFIG_PATH" \
        --wait "$WAIT_TIMEOUT" \
        --config -
    EOT
    environment = {
      KIND        = self.input.kind_binary
      KIND_CONFIG = self.input.config
      # Network shared with the registry caches (kind's default is "kind").
      KIND_EXPERIMENTAL_DOCKER_NETWORK = self.input.docker_network
      CLUSTER_NAME                     = self.input.name
      NODE_IMAGE                       = self.input.image
      KUBECONFIG_PATH                  = self.input.kubeconfig_path
      WAIT_TIMEOUT                     = var.wait_timeout
    }
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      "$KIND" delete cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG_PATH"
      rm -f "$KUBECONFIG_PATH"
    EOT
    environment = {
      KIND            = self.input.kind_binary
      CLUSTER_NAME    = self.input.name
      KUBECONFIG_PATH = self.input.kubeconfig_path
    }
  }
}
