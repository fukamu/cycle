[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0, ValueFromRemainingArguments)]
    [ValidateSet("compile", "generate")]
    [string[]]$SqlcCommand,
    [ValidateSet("Auto", "Host", "Docker", "Go")]
    [string]$Runner = "Auto"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$backendPath = (Resolve-Path -LiteralPath (Join-Path $repoRoot "backend")).Path
$requiredVersion = "1.31.1"
$dockerImage = "sqlc/sqlc:$requiredVersion"
$goPackage = "github.com/sqlc-dev/sqlc/cmd/sqlc@v$requiredVersion"
$toolSuffix = if ($IsWindows -or $env:OS -eq "Windows_NT") { ".exe" } else { "" }
$managedToolDir = Join-Path $repoRoot ".tmp/tools/sqlc-$requiredVersion"
$managedSqlc = Join-Path $managedToolDir "sqlc$toolSuffix"

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

function Get-HostSqlcVersion {
    if (-not (Get-Command sqlc -ErrorAction SilentlyContinue)) {
        return $null
    }

    $versionOutput = & sqlc version 2>&1
    if ($LASTEXITCODE -ne 0) {
        return $null
    }

    $versionText = ($versionOutput | Out-String).Trim()
    if ($versionText -match '^v?(?<version>\d+\.\d+\.\d+)$') {
        return $Matches.version
    }

    return $null
}

function Test-DockerServer {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        return $false
    }

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $null = & docker version --format '{{.Server.Version}}' 2>&1
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

$hostVersion = Get-HostSqlcVersion
$selectedRunner = $Runner

if ($Runner -eq "Auto") {
    if ($hostVersion -eq $requiredVersion) {
        $selectedRunner = "Host"
    }
    elseif (Test-DockerServer) {
        if ($null -ne $hostVersion) {
            Write-Warning "Host sqlc $hostVersion does not match required version $requiredVersion; using Docker."
        }
        $selectedRunner = "Docker"
    }
    elseif (Get-Command go -ErrorAction SilentlyContinue) {
        if ($null -ne $hostVersion) {
            Write-Warning "Host sqlc $hostVersion does not match required version $requiredVersion; using the pinned temporary Go tool."
        }
        $selectedRunner = "Go"
    }
    else {
        throw "sqlc $requiredVersion is unavailable. Install it, start Docker, or install Go; see docs/development.md."
    }
}

if ($selectedRunner -eq "Host" -and $hostVersion -ne $requiredVersion) {
    $foundVersion = if ($null -eq $hostVersion) { "not found" } else { $hostVersion }
    throw "Host sqlc $requiredVersion is required; found: $foundVersion."
}

if ($selectedRunner -eq "Docker" -and -not (Test-DockerServer)) {
    throw "Docker runner was requested, but the Docker server is unavailable."
}

if ($selectedRunner -eq "Go" -and -not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw "Go runner was requested, but Go is unavailable."
}

Push-Location $backendPath
try {
    foreach ($command in $SqlcCommand) {
        switch ($selectedRunner) {
            "Host" {
                Write-Host "Running sqlc $command with host sqlc $requiredVersion."
                Invoke-Checked -Command sqlc -Arguments @($command)
            }
            "Docker" {
                Write-Host "Running sqlc $command with disposable Docker image $dockerImage."
                $dockerArguments = @(
                    "run",
                    "--rm",
                    "--volume", "${backendPath}:/src",
                    "--workdir", "/src"
                )

                if (-not ($IsWindows -or $env:OS -eq "Windows_NT") -and (Get-Command id -ErrorAction SilentlyContinue)) {
                    $userId = (& id -u).Trim()
                    $groupId = (& id -g).Trim()
                    if ($LASTEXITCODE -eq 0 -and $userId -match '^\d+$' -and $groupId -match '^\d+$') {
                        $dockerArguments += @("--user", "${userId}:${groupId}")
                    }
                }

                $dockerArguments += @($dockerImage, $command)
                Invoke-Checked -Command docker -Arguments $dockerArguments
            }
            "Go" {
                if (-not (Test-Path -LiteralPath $managedSqlc)) {
                    Write-Host "Building temporary sqlc $requiredVersion tool with Go."
                    New-Item -ItemType Directory -Force -Path $managedToolDir | Out-Null
                    $goBinWasSet = Test-Path Env:GOBIN
                    $previousGoBin = $env:GOBIN
                    try {
                        $env:GOBIN = $managedToolDir
                        Invoke-Checked -Command go -Arguments @("install", $goPackage)
                    }
                    finally {
                        if ($goBinWasSet) {
                            $env:GOBIN = $previousGoBin
                        }
                        else {
                            Remove-Item Env:GOBIN -ErrorAction SilentlyContinue
                        }
                    }
                }
                Write-Host "Running sqlc $command with temporary tool $managedSqlc."
                Invoke-Checked -Command $managedSqlc -Arguments @($command)
            }
        }
    }
}
finally {
    Pop-Location
}
