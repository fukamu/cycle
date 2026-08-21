[CmdletBinding()]
param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Assert-Command {
    param([Parameter(Mandatory)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found. See docs/development.md."
    }
}

function Copy-ExampleIfMissing {
    param(
        [Parameter(Mandatory)][string]$Example,
        [Parameter(Mandatory)][string]$Destination
    )

    if (Test-Path -LiteralPath $Destination) {
        Write-Host "Preserved existing file: $Destination"
        return
    }
    Copy-Item -LiteralPath $Example -Destination $Destination
    Write-Host "Created: $Destination"
}

Assert-Command "node"
Assert-Command "pnpm"
Assert-Command "go"

$nodeVersion = (& node --version).TrimStart('v')
if ([version]$nodeVersion -lt [version]"24.0.0") {
    throw "Node.js 24 or newer is required; found $nodeVersion."
}

$pnpmVersion = (& pnpm --version).Trim()
if ($pnpmVersion -ne "11.22.0") {
    throw "pnpm 11.22.0 is required for reproducible local/CI builds; found $pnpmVersion."
}

$goVersion = (& go env GOVERSION).TrimStart("go")
if ($goVersion -ne "1.26.6") {
    throw "Go 1.26.6 is required for reproducible local/CI builds; found $goVersion."
}

Copy-ExampleIfMissing `
    -Example (Join-Path $repoRoot ".env.example") `
    -Destination (Join-Path $repoRoot ".env")
Copy-ExampleIfMissing `
    -Example (Join-Path $repoRoot "frontend/.env.example") `
    -Destination (Join-Path $repoRoot "frontend/.env.local")

if (-not $SkipInstall) {
    Push-Location $repoRoot
    try {
        & pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) {
            throw "pnpm install failed with exit code $LASTEXITCODE."
        }
        & pnpm --filter pdcai-cloudflare run types
        if ($LASTEXITCODE -ne 0) {
            throw "Cloudflare type generation failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    Push-Location (Join-Path $repoRoot "backend")
    try {
        & go mod download
        if ($LASTEXITCODE -ne 0) {
            throw "go mod download failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host "Local files are ready. Review .env, then follow docs/development.md to start PostgreSQL and the servers."
