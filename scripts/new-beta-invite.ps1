[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z0-9][a-z0-9_-]{0,63}$')]
    [string]$InviteId
)

$ErrorActionPreference = "Stop"

$randomBytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
$encoded = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$token = "pdcai_beta_$encoded"
$tokenBytes = [System.Text.Encoding]::UTF8.GetBytes($token)
$digestBytes = [System.Security.Cryptography.SHA256]::HashData($tokenBytes)
$digest = [Convert]::ToHexString($digestBytes).ToLowerInvariant()
$entry = [ordered]@{ id = $InviteId; digest = $digest } | ConvertTo-Json -Compress

Write-Warning "The raw invite token is displayed once. Do not run this script in a recorded or shared terminal."
Write-Host "Invite ID: $InviteId"
Write-Host "Token: $token"
Write-Host "Allowlist entry: $entry"
