# Staging Light Terraform

This root module manages the Cloudflare Turnstile widget for `cycle.staging.fukamu.matoruru.com`. The Worker, Container image, static assets, custom domain, runtime secrets, and database migrations are application deployment concerns owned by Wrangler/GitHub Actions.

Terraform state uses the S3 backend against a manually bootstrapped, private R2 bucket. Credentials are supplied only through `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; never add them to `backend.hcl`, `terraform.tfvars`, shell history, or the repository.

R2 is strongly consistent and supports the conditional `PutObject` operations used by Terraform's S3 lockfile. Cloudflare documents R2 as a supported Terraform remote backend, but HashiCorp only tests the S3 backend against Amazon S3. R2 also does not provide S3-style object version history. Keep the bucket and its scoped credential private, avoid concurrent manual applies, retain `use_lockfile = true`, and capture a protected state backup before risky state operations.

`Terraform Plan Staging` creates a commit-bound saved plan after successful main CI. The configured owner approves it by manually dispatching `Terraform Apply Staging` with the Plan run ID. Apply verifies the actor, immutable artifact, and current main HEAD, then uses the optional protected `staging-terraform-apply` GitHub Environment before applying that exact plan. A successful Apply triggers the migration-first Wrangler/Container deployment. Local Apply is not the normal release path.

The complete bootstrap, repository inputs, approval configuration, secret handling, and deploy sequence is in [`docs/deployment.md`](../../../docs/deployment.md).
