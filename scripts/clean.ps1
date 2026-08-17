[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$All
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$rootPrefix = $repoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

function Remove-GeneratedPath {
    param([Parameter(Mandatory)][string]$RelativePath)

    $target = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $RelativePath))
    if (-not $target.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside the repository: $target"
    }
    if (-not (Test-Path -LiteralPath $target)) {
        return
    }
    if ($PSCmdlet.ShouldProcess($target, "Remove regenerable local artifact")) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

$safeTargets = @(
    ".tmp",
    "backend/bin",
    "backend/coverage.out",
    "backend/server",
    "backend/server.exe",
    "backend/migrate",
    "backend/migrate.exe",
    "frontend/dist",
    "frontend/coverage",
    "frontend/playwright-report",
    "frontend/test-results",
    "frontend/.npm-cache",
    "frontend/.eslintcache",
    "frontend/tsconfig.tsbuildinfo",
    "frontend/tsconfig.app.tsbuildinfo",
    "frontend/tsconfig.node.tsbuildinfo"
)

foreach ($target in $safeTargets) {
    Remove-GeneratedPath $target
}

if ($All) {
    Remove-GeneratedPath "frontend/node_modules"
}

Write-Host "Cleanup complete. Environment files, databases, Docker resources, and browser data were not touched."
