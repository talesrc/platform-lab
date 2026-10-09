locals {
  kubeconfig_path = abspath(coalesce(var.kubeconfig_path, "${path.module}/kubeconfig"))

  node_image = join("@", compact([
    "${var.node_image_repository}:${var.kubernetes_version}",
    var.node_image_digest,
  ]))

  control_plane_nodes = [
    for i in range(var.control_plane_count) : merge(
      { role = "control-plane" },
      # Only the first control-plane node receives ingress traffic.
      [for ingress in [{
        labels = { "ingress-ready" = "true" }
        extraPortMappings = [
          { containerPort = var.ingress_node_ports.http, hostPort = var.ingress_host_ports.http, protocol = "TCP" },
          { containerPort = var.ingress_node_ports.https, hostPort = var.ingress_host_ports.https, protocol = "TCP" },
        ]
      }] : ingress if var.ingress_ready && i == 0]...
    )
  ]

  worker_nodes = [
    for i in range(var.worker_count) : merge(
      { role = "worker" },
      [for labels in [var.worker_labels] : { labels = labels } if length(labels) > 0]...
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
    [for gates in [var.feature_gates] : { featureGates = gates } if length(gates) > 0]...
  ))
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
  }

  triggers_replace = [var.cluster_name, local.node_image, local.kind_config, local.kubeconfig_path]

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
      KIND            = self.input.kind_binary
      KIND_CONFIG     = self.input.config
      CLUSTER_NAME    = self.input.name
      NODE_IMAGE      = self.input.image
      KUBECONFIG_PATH = self.input.kubeconfig_path
      WAIT_TIMEOUT    = var.wait_timeout
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
