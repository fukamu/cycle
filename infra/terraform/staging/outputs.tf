output "turnstile_sitekey" {
  description = "Public sitekey for VITE_TURNSTILE_SITE_KEY / GitHub TURNSTILE_SITE_KEY."
  value       = cloudflare_turnstile_widget.anonymous_bootstrap.sitekey
}

output "staging_origin" {
  description = "Canonical Staging Light origin."
  value       = "https://${var.public_hostname}"
}
