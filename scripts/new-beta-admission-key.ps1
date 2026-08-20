[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$randomBytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
$key = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

Write-Warning "The cookie signing key is displayed once. Store it directly as BETA_ADMISSION_COOKIE_KEY and do not record it elsewhere."
Write-Host $key
