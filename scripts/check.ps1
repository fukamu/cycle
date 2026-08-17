[CmdletBinding()]
param(
    [ValidateSet("all", "frontend", "backend")]
    [string]$Scope = "all",
    [switch]$E2E
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$runFrontend = $Scope -in @("all", "frontend")
$runBackend = $Scope -in @("all", "backend")

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
        Invoke-Checked go build -o (Join-Path $buildDir "server$suffix") ./cmd/server
        Invoke-Checked go build -o (Join-Path $buildDir "migrate$suffix") ./cmd/migrate
    }
    finally {
        Pop-Location
    }
}

if ($E2E) {
    if ([string]::IsNullOrWhiteSpace($env:TEST_DATABASE_URL)) {
        throw "Set TEST_DATABASE_URL to a disposable PostgreSQL test database before running E2E."
    }
    Push-Location (Join-Path $repoRoot "frontend")
    try {
        Invoke-Checked npm run test:e2e
    }
    finally {
        Pop-Location
    }
}

Write-Host "Checks completed successfully."
