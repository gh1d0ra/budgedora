# Budgedora's Cloudflare resources as code.
#
# Terraform owns the stateful resources (databases, KV); wrangler owns the Worker's code, routes and bindings
# (wrangler.toml), because it deploys on every release. Existing production resources are adopted with the
# import blocks in imports.tf, so `terraform apply` never recreates them.
#
#   cd infra
#   cp terraform.tfvars.example terraform.tfvars   # your account id
#   export CLOUDFLARE_API_TOKEN=…                    # D1 edit, Workers KV edit
#   terraform init && terraform plan

terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {} # reads CLOUDFLARE_API_TOKEN

variable "account_id" {
  description = "Cloudflare account id (dashboard → Workers & Pages → Account details)"
  type        = string
}

# The family's data. Never destroyed by Terraform.
resource "cloudflare_d1_database" "main" {
  account_id = var.account_id
  name       = "budgedora"
  read_replication = {
    mode = "disabled"
  }
  lifecycle {
    prevent_destroy = true
  }
}

# Pull-request previews get their own empty database (see docs/release.md).
resource "cloudflare_d1_database" "preview" {
  account_id = var.account_id
  name       = "budgedora-preview"
  read_replication = {
    mode = "disabled"
  }
}

# Daily and monthly compressed snapshots (src/worker.ts → backupToKv).
resource "cloudflare_workers_kv_namespace" "backups" {
  account_id = var.account_id
  title      = "budgedora-backups"
  lifecycle {
    prevent_destroy = true
  }
}

output "d1_main_id" {
  description = "database_id for [[d1_databases]] in wrangler.toml"
  value       = cloudflare_d1_database.main.id
}

output "d1_preview_id" {
  description = "database_id for [[env.preview.d1_databases]] in wrangler.toml"
  value       = cloudflare_d1_database.preview.id
}

output "kv_backups_id" {
  description = "id for [[kv_namespaces]] BACKUPS in wrangler.toml"
  value       = cloudflare_workers_kv_namespace.backups.id
}
