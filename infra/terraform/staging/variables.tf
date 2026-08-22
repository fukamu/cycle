variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the matoruru.com zone and Turnstile widget."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character hexadecimal Cloudflare account ID."
  }
}

variable "public_hostname" {
  description = "Fixed Staging Light hostname. Production must use a separate root module and state."
  type        = string
  default     = "cycle.staging.fukamu.matoruru.com"

  validation {
    condition     = var.public_hostname == "cycle.staging.fukamu.matoruru.com"
    error_message = "This root module may only manage cycle.staging.fukamu.matoruru.com."
  }
}
