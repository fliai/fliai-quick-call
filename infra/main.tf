# Public downloads for FLiAI Quick Call (Mac .dmg, Windows -setup.exe, install scripts).
# The bucket only ever holds the latest release: CI uploads fixed file names,
# deletes anything else and fails if the total goes over 50 MB.

variable "account_id" {
  type    = string
  default = "5cf45d4021da2e96449ecd54ca802dea"
}

variable "zone_name" {
  type    = string
  default = "fliai.lk"
}

variable "bucket_name" {
  type    = string
  default = "fliai-quick-call-downloads"
}

variable "domain" {
  type    = string
  default = "cdn-quickcall.fliai.lk"
}

data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}

resource "cloudflare_r2_bucket" "downloads" {
  account_id = var.account_id
  name       = var.bucket_name
  location   = "apac"

  lifecycle {
    prevent_destroy = true
  }
}

# Public read through a custom domain (r2.dev stays off).
resource "cloudflare_r2_custom_domain" "downloads" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.downloads.name
  domain      = var.domain
  zone_id     = data.cloudflare_zone.this.zone_id
  enabled     = true
  min_tls     = "1.2"
}

# Clean up half-finished uploads so they never count against the 50 MB budget.
resource "cloudflare_r2_bucket_lifecycle" "downloads" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.downloads.name

  rules = [{
    id      = "abort-incomplete-uploads"
    enabled = true
    conditions = {
      prefix = ""
    }
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 86400
        type    = "Age"
      }
    }
  }]
}

output "download_base_url" {
  value = "https://${var.domain}"
}
