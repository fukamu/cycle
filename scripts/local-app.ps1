[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8080,
    [switch]$Detached,
    [switch]$Down
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot "compose.local.yaml"
$composeArguments = @(
    "compose",
    "--project-name", "pdcai-local",
    "--file", $composeFile
)

function Invoke-Docker {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)

    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed ($LASTEXITCODE): docker $($Arguments -join ' ')"
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker was not found. Install and start Docker Desktop, then retry."
}

$contextOutput = & docker context inspect
if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect the Docker context. No local environment was started."
}
$dockerContext = $contextOutput | ConvertFrom-Json
$dockerEndpoint = [string]$dockerContext[0].Endpoints.docker.Host
if ($dockerEndpoint -notmatch '^(npipe|unix)://') {
    throw "Refusing Docker context '$dockerEndpoint': only a local Docker daemon is allowed."
}

if ($Down) {
    Invoke-Docker @composeArguments down --volumes --remove-orphans
    Write-Host "PDCAI local environment was removed."
    exit 0
}

$localPortWasSet = Test-Path Env:PDCAI_LOCAL_PORT
$previousLocalPort = $env:PDCAI_LOCAL_PORT
$env:PDCAI_LOCAL_PORT = [string]$Port
$keepRunning = $false

try {
    Invoke-Docker @composeArguments up --build --detach --remove-orphans app

    $readyURL = "http://127.0.0.1:$Port/readyz"
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $readyURL -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                $ready = $true
                break
            }
        }
        catch {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $ready) {
        & docker @composeArguments logs --no-color
        throw "PDCAI did not become ready at $readyURL."
    }

    Write-Host "PDCAI is ready: http://localhost:$Port"
    Write-Host "The database is disposable and external AI/authentication services are disabled."
    if ($Detached) {
        $keepRunning = $true
        Write-Host "Run 'pwsh ./scripts/local-app.ps1 -Down' to stop and remove it."
    }
    else {
        Read-Host "Press Enter to stop and remove the local environment" | Out-Null
    }
}
finally {
    if (-not $keepRunning) {
        & docker @composeArguments down --volumes --remove-orphans
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Automatic cleanup failed. Run 'pwsh ./scripts/local-app.ps1 -Down'."
        }
    }
    if ($localPortWasSet) {
        $env:PDCAI_LOCAL_PORT = $previousLocalPort
    }
    else {
        Remove-Item Env:PDCAI_LOCAL_PORT -ErrorAction SilentlyContinue
    }
}
