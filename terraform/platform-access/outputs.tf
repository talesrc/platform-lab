output "vault_paths" {
  description = "Vault KV paths (mount secret/) written for Backstage; External Secrets syncs them."
  value       = nonsensitive(keys(local.backstage_secrets))
}

output "vault_url" {
  description = "Vault UI (lab-only root token: kubectl -n vault get secret vault-unseal-keys)."
  value       = "https://vault.lab.localhost"
}
