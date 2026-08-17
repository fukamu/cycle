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
Assert-Command "npm"
Assert-Command "go"

$nodeVersion = (& node --version).TrimStart('v')
if ([version]$nodeVersion -lt [version]"24.0.0") {
    throw "Node.js 24 or newer is required; found $nodeVersion."
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
    Push-Location (Join-Path $repoRoot "frontend")
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host "Local files are ready. Review .env, then follow docs/development.md to start PostgreSQL and the servers."
