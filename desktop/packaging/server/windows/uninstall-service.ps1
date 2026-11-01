<#
.SYNOPSIS
  Removes the NalamDesk Server service. The clinic's data is kept.
.DESCRIPTION
  Run in an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File "C:\Program Files\NalamDesk Server\service\uninstall-service.ps1"
  The data folder (%ProgramData%\NalamDesk\server) is never deleted.
#>
$ErrorActionPreference = 'Stop'
$serviceExe = Join-Path $PSScriptRoot 'nalamdesk-server-service.exe'
$existing = Get-Service -Name 'NalamDeskServer' -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Status -ne 'Stopped') {
        Stop-Service -Name 'NalamDeskServer'
        $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
    }
    & $serviceExe uninstall
}
Get-NetFirewallRule -DisplayName 'NalamDesk Server' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "NalamDesk Server service removed. The clinic's data is still in $env:ProgramData\NalamDesk\server."
