[CmdletBinding()]
param(
    [string]$Path = (Join-Path (Split-Path -Parent $PSScriptRoot) ".env")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Environment file was not found: $Path"
}

$loaded = 0
foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*$' -or $line -match '^\s*#') {
        continue
    }
    if ($line -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
        throw "Unsupported environment line in ${Path}: $line"
    }
    Set-Item -LiteralPath "Env:$($Matches[1])" -Value $Matches[2]
    $loaded++
}

Write-Host "Loaded $loaded environment variables from $Path into the current PowerShell process."
