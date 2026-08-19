[CmdletBinding()]
param(
    [ValidateSet("all", "frontend", "backend", "infrastructure")]
    [string]$Scope = "all",
    [switch]$E2E
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$runFrontend = $Scope -in @("all", "frontend")
$runBackend = $Scope -in @("all", "backend")
$runInfrastructure = $Scope -in @("all", "infrastructure")

if ($E2E -and $Scope -ne "all") {
    throw "E2E requires -Scope all because it starts both the frontend build and backend server."
}

function Assert-Command {
    param([Parameter(Mandatory)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found. See docs/development.md."
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(ValueFromRemainingArguments)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')"
    }
}

if ($runFrontend) {
    Assert-Command "npm"
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "frontend/node_modules"))) {
        throw "frontend/node_modules is missing. Run pwsh ./scripts/setup.ps1 first."
    }
    Push-Location (Join-Path $repoRoot "frontend")
    try {
        Invoke-Checked npm run format:check
        Invoke-Checked npm run lint
        Invoke-Checked npm run typecheck
        Invoke-Checked npm test
        Invoke-Checked npm run build
    }
    finally {
        Pop-Location
    }
}

if ($runBackend) {
    Assert-Command "go"
    Assert-Command "sqlc"
    Assert-Command "git"
    Push-Location (Join-Path $repoRoot "backend")
    try {
        Invoke-Checked sqlc compile
        Invoke-Checked sqlc generate
        Invoke-Checked git diff --exit-code -- internal/infrastructure/postgres/generated

        $unformatted = @(& gofmt -l .)
        if ($LASTEXITCODE -ne 0) {
            throw "gofmt inspection failed with exit code $LASTEXITCODE."
        }
        if ($unformatted.Count -gt 0) {
            throw "gofmt is required for: $($unformatted -join ', ')"
        }

        Invoke-Checked go vet ./...
        Invoke-Checked go test -count=1 ./...

        $buildDir = Join-Path $repoRoot ".tmp/check"
        New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
        $suffix = if ($IsWindows -or $env:OS -eq "Windows_NT") { ".exe" } else { "" }
        Invoke-Checked -Command go -Arguments @("build", "-o", (Join-Path $buildDir "server$suffix"), "./cmd/server")
        Invoke-Checked -Command go -Arguments @("build", "-o", (Join-Path $buildDir "migrate$suffix"), "./cmd/migrate")
    }
    finally {
        Pop-Location
    }
}

if ($runInfrastructure) {
    Assert-Command "terraform"
    Assert-Command "npm"
    Assert-Command "docker"
    Invoke-Checked docker compose --file (Join-Path $repoRoot "compose.local.yaml") config --quiet
    $terraformDataDirWasSet = Test-Path Env:TF_DATA_DIR
    $previousTerraformDataDir = $env:TF_DATA_DIR
    $env:TF_DATA_DIR = Join-Path $repoRoot ".tmp/terraform-check"
    Push-Location (Join-Path $repoRoot "infra/terraform/staging")
    try {
        Invoke-Checked terraform fmt -check -recursive .
        Invoke-Checked terraform init -backend=false -input=false
        Invoke-Checked terraform validate
    }
    finally {
        Pop-Location
        if ($terraformDataDirWasSet) {
            $env:TF_DATA_DIR = $previousTerraformDataDir
        }
        else {
            Remove-Item Env:TF_DATA_DIR -ErrorAction SilentlyContinue
        }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "frontend/node_modules"))) {
        throw "frontend/node_modules is missing. Run pwsh ./scripts/setup.ps1 first."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "frontend/dist"))) {
        Push-Location (Join-Path $repoRoot "frontend")
        try {
            Invoke-Checked npm run build
        }
        finally {
            Pop-Location
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "cloudflare/node_modules"))) {
        throw "cloudflare/node_modules is missing. Run pwsh ./scripts/setup.ps1 first."
    }
    Push-Location (Join-Path $repoRoot "cloudflare")
    try {
        $previousXdgConfigHome = $env:XDG_CONFIG_HOME
        $env:XDG_CONFIG_HOME = Join-Path $repoRoot "cloudflare/.wrangler/config"
        Invoke-Checked npm run check
        Invoke-Checked npm run deploy:dry-run
    }
    finally {
        $env:XDG_CONFIG_HOME = $previousXdgConfigHome
        Pop-Location
    }
}

if ($E2E) {
    if ([string]::IsNullOrWhiteSpace($env:TEST_DATABASE_URL)) {
        throw "Set TEST_DATABASE_URL to a disposable PostgreSQL test database before running E2E."
    }

    $e2eSuffix = if ($IsWindows -or $env:OS -eq "Windows_NT") { ".exe" } else { "" }
    $e2eMigrateBinary = Join-Path $repoRoot ".tmp/check/migrate$e2eSuffix"
    $e2eServerBinary = Join-Path $repoRoot ".tmp/check/server$e2eSuffix"
    if (-not (Test-Path -LiteralPath $e2eMigrateBinary) -or -not (Test-Path -LiteralPath $e2eServerBinary)) {
        throw "E2E binaries are missing. Run E2E with -Scope all so the backend build runs first."
    }

    $databaseUrlWasSet = Test-Path Env:DATABASE_URL
    $previousDatabaseUrl = $env:DATABASE_URL
    $serverBinaryWasSet = Test-Path Env:PDCAI_SERVER_BINARY
    $previousServerBinary = $env:PDCAI_SERVER_BINARY
    try {
        $env:DATABASE_URL = $env:TEST_DATABASE_URL
        Push-Location (Join-Path $repoRoot "backend")
        try {
            Invoke-Checked $e2eMigrateBinary
        }
        finally {
            Pop-Location
        }

        $env:PDCAI_SERVER_BINARY = $e2eServerBinary
        Push-Location (Join-Path $repoRoot "frontend")
        try {
            Invoke-Checked npm run test:e2e
        }
        finally {
            Pop-Location
        }
    }
    finally {
        if ($databaseUrlWasSet) {
            $env:DATABASE_URL = $previousDatabaseUrl
        }
        else {
            Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
        }
        if ($serverBinaryWasSet) {
            $env:PDCAI_SERVER_BINARY = $previousServerBinary
        }
        else {
            Remove-Item Env:PDCAI_SERVER_BINARY -ErrorAction SilentlyContinue
        }
    }
}

Write-Host "Checks completed successfully."
