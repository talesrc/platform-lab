terraform {
  # terraform_data needs >= 1.4. The cluster itself is managed by the kind CLI.
  required_version = ">= 1.6"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "~> 2.9"
    }
  }
}
