# Adopt the resources that existed before Terraform (ids from wrangler.toml). After the first
# `terraform apply` they live in the state, and these blocks do nothing.

import {
  to = cloudflare_d1_database.main
  id = "${var.account_id}/58f98c55-af37-406b-a804-8da0828e5cf4"
}

import {
  to = cloudflare_workers_kv_namespace.backups
  id = "${var.account_id}/09bd7bf31d8b47d0933db256b1091d24"
}
