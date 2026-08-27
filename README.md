# FUKAMU Cycle

FUKAMU Cycleは、目標（Goal）ごとにPDCA Cycleを重ね、Cycle完了後のGoal Reviewで目標を維持・更新・終了できるG-PDCAアプリです。Cloudflare WorkerがReact / Vite SPAをedge配信し、同一originのAPIをCloudflare Container上のGoへrouteします。Goal、immutable Goal Version、Cycle、Review DraftはPostgreSQLへ保存します。

アプリケーション要件・仕様・設計の最上位Source of Truthは [`docs/design.md`](docs/design.md) です。このREADMEは概要と入口だけを所有し、手順や設定値は専門文書へ委譲します。

## Quick start

Docker Desktop、Bash 5、curlがある環境では、外部AI / Google credentialや既存local DBを使わない破棄可能previewを1 commandで起動できます。

```bash
./scripts/local-app.sh
```

Ready後に`http://localhost:8080`を開き、終了時はterminalでEnterを押します。別port、detached運用、sourceからの通常開発、必要toolは [`docs/development.md`](docs/development.md) を参照してください。

## Documentation

| Theme | Source of Truth |
|---|---|
| Product behavior / API / architecture / invariants | [`docs/design.md`](docs/design.md) |
| Local setup / development / checks / codegen / AI evaluation / local troubleshooting | [`docs/development.md`](docs/development.md) |
| Environment variables / scope / secret-public classification | [`docs/environment.md`](docs/environment.md) |
| Database / Migration / reset / data safety / DB troubleshooting | [`docs/database.md`](docs/database.md) |
| Terraform / deployment / monitoring / incident / rollback / production troubleshooting | [`docs/operations.md`](docs/operations.md) |
| Temporary Closed Beta admission | [`docs/closed-beta-admission.md`](docs/closed-beta-admission.md) |
| Coding-agent repository governance | [`AGENTS.md`](AGENTS.md) |

Closed Beta runbookは一時文書であり、承認済み撤去条件が成立するまで維持します。通常の開発・Staging運用では上の専門文書を入口にしてください。

## Repository

- Canonical URL: <https://github.com/fukamu/cycle>
- `frontend/`: React SPA、browser state、Vitest、Playwright
- `backend/`: Go API、PostgreSQL adapter、migration
- `cloudflare/`: Worker routing、Container、static assets、Wrangler config
- `infra/terraform/`: Terraformが所有するCloudflare resource
- `scripts/`: Setup、quality / security checks、safe clean、明示確認付きlocal DB reset
- `.github/workflows/`: CI、saved Terraform plan / approved apply、migration-first deploy

Pull request前の検証、E2E用DBの安全条件、commit前gateは [`docs/development.md`](docs/development.md#品質チェック) に従います。Cloud deployやProduction dataへ検証目的の変更を加えません。
