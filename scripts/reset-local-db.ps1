[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
param(
    [string]$ContainerName = "pdcai-postgres",
    [ValidatePattern('^pdcai(?:_dev|_test)?$')]
    [string]$DatabaseName = "pdcai",
    [Parameter(Mandatory)]
    [string]$ConfirmDatabaseName
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

if ($ConfirmDatabaseName -cne $DatabaseName) {
    throw "Confirmation did not match DatabaseName exactly. No database was changed."
}
if ($env:APP_ENV -eq "production") {
    throw "Refusing to reset a database while APP_ENV=production."
}

$targetDescription = "database '$DatabaseName' in local Docker container '$ContainerName'"
if ($WhatIfPreference) {
    $null = $PSCmdlet.ShouldProcess($targetDescription, "Drop, recreate, and migrate")
    return
}

foreach ($command in @("docker", "go")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command '$command' was not found. No database was changed."
    }
}

$dockerContext = & docker context inspect | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $dockerContext) {
    throw "Could not inspect the Docker context. No database was changed."
}
$dockerHost = [string]$dockerContext[0].Endpoints.docker.Host
if ($dockerHost -notmatch '^(npipe|unix)://') {
    throw "Refusing Docker context '$dockerHost': only a local Docker daemon is allowed."
}

$containerState = (& docker inspect --format '{{.State.Status}}' $ContainerName).Trim()
$containerImage = (& docker inspect --format '{{.Config.Image}}' $ContainerName).Trim()
$containerEnvironment = & docker inspect --format '{{json .Config.Env}}' $ContainerName | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect container '$ContainerName'. No database was changed."
}
if ($containerState -ne "running") {
    throw "Container '$ContainerName' is not running. No database was changed."
}
if ($containerImage -notmatch '^postgres:17(?:-|$)') {
    throw "Container '$ContainerName' does not use the expected PostgreSQL 17 image. No database was changed."
}

$postgresUser = ($containerEnvironment | Where-Object { $_ -like 'POSTGRES_USER=*' } | Select-Object -First 1) -replace '^POSTGRES_USER=', ''
$postgresPassword = ($containerEnvironment | Where-Object { $_ -like 'POSTGRES_PASSWORD=*' } | Select-Object -First 1) -replace '^POSTGRES_PASSWORD=', ''
if ([string]::IsNullOrWhiteSpace($postgresUser) -or [string]::IsNullOrWhiteSpace($postgresPassword)) {
    throw "POSTGRES_USER/POSTGRES_PASSWORD are unavailable on '$ContainerName'. No database was changed."
}

$hostPort = (& docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' $ContainerName).Trim()
if ($LASTEXITCODE -ne 0 -or $hostPort -notmatch '^\d+$') {
    throw "Container '$ContainerName' does not expose PostgreSQL to a local host port. No database was changed."
}

$goVersion = (& go env GOVERSION).TrimStart("go")
if ($LASTEXITCODE -ne 0 -or $goVersion -ne "1.26.6") {
    throw "Go 1.26.6 is required before reset so migrations can run. No database was changed."
}

if (-not $PSCmdlet.ShouldProcess($targetDescription, "Permanently delete all data, recreate the database, and apply migrations")) {
    return
}

& docker exec $ContainerName dropdb --username $postgresUser --if-exists --force $DatabaseName
if ($LASTEXITCODE -ne 0) {
    throw "dropdb failed; the reset was not completed."
}
& docker exec $ContainerName createdb --username $postgresUser --owner $postgresUser $DatabaseName
if ($LASTEXITCODE -ne 0) {
    throw "createdb failed; the database may be absent and requires manual recovery."
}

$encodedUser = [System.Uri]::EscapeDataString($postgresUser)
$encodedPassword = [System.Uri]::EscapeDataString($postgresPassword)
$previousDatabaseURL = $env:DATABASE_URL
$previousMigrationsDir = $env:MIGRATIONS_DIR
$env:DATABASE_URL = "postgres://${encodedUser}:${encodedPassword}@127.0.0.1:$hostPort/$DatabaseName`?sslmode=disable"
$env:MIGRATIONS_DIR = "migrations"

Push-Location (Join-Path $repoRoot "backend")
try {
    & go run ./cmd/migrate
    if ($LASTEXITCODE -ne 0) {
        throw "Migration failed. The local database exists but may be empty or partially migrated."
    }
}
finally {
    Pop-Location
    $env:DATABASE_URL = $previousDatabaseURL
    $env:MIGRATIONS_DIR = $previousMigrationsDir
}

Write-Host "Local database '$DatabaseName' was recreated and migrated."
