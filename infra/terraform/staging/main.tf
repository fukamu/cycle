provider "cloudflare" {}

resource "cloudflare_turnstile_widget" "anonymous_bootstrap" {
  account_id = var.cloudflare_account_id
  domains    = [var.public_hostname]
  mode       = "invisible"
  name       = "PDCAI Staging anonymous bootstrap"
  region     = "world"

  lifecycle {
    prevent_destroy = true
  }
}
