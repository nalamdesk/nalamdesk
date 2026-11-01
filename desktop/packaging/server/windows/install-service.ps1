<#
.SYNOPSIS
  Installs or upgrades NalamDesk Server as a Windows service.
.DESCRIPTION
  Run from the extracted nalamdesk-server folder in an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File .\service\install-service.ps1
  Copies the server to Program Files, creates the data folder (readable only
  by SYSTEM and Administrators), opens the port on private and domain
  networks, and registers the "NalamDesk Server" service. Re-run it from a
  newer package to upgrade: the service is stopped, replaced and started.
  Patient data in the data folder is never touched.
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'NalamDesk Server'),
    [int]$Port = 3000,
    [switch]$NoFirewall
)
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated (Run as administrator) PowerShell.'
}

$source = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $env:ProgramData 'NalamDesk\server'
$serviceExe = Join-Path $InstallDir 'service\nalamdesk-server-service.exe'
$existing = Get-Service -Name 'NalamDeskServer' -ErrorAction SilentlyContinue

if ($existing -and $existing.Status -ne 'Stopped') {
    Write-Host 'Stopping NalamDesk Server for the upgrade...'
    Stop-Service -Name 'NalamDeskServer'
    $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
}

if ((Resolve-Path $source).Path.TrimEnd('\') -ne [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')) {
    Write-Host "Copying NalamDesk Server to $InstallDir..."
    if (Test-Path $InstallDir) {
        # Replace the program files only; the data folder lives elsewhere.
        foreach ($part in 'app', 'bin', 'runtime', 'service') {
            $target = Join-Path $InstallDir $part
            if (Test-Path $target) { Remove-Item -Recurse -Force $target }
        }
    }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Copy-Item -Recurse -Force -Path (Join-Path $source '*') -Destination $InstallDir
}

if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
}
# Only SYSTEM (the service) and Administrators can read the vault and key file.
& icacls.exe $dataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not set permissions on $dataDir." }

$configPath = Join-Path $dataDir 'server.json'
if (-not (Test-Path $configPath)) {
    $config = [ordered]@{ dataDir = $dataDir; host = '0.0.0.0'; port = $Port; keyProvider = 'key-file' }
    $config | ConvertTo-Json | Set-Content -Path $configPath -Encoding ASCII
}

if (-not $NoFirewall) {
    $rule = Get-NetFirewallRule -DisplayName 'NalamDesk Server' -ErrorAction SilentlyContinue
    if (-not $rule) {
        New-NetFirewallRule -DisplayName 'NalamDesk Server' -Direction Inbound -Protocol TCP -LocalPort $Port `
            -Action Allow -Profile Private, Domain | Out-Null
    }
}

# Put nalamdesk-server on the machine PATH for the CLI.
$bin = Join-Path $InstallDir 'bin'
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if (($machinePath -split ';') -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', "$machinePath;$bin", 'Machine')
}

if (-not $existing) {
    & $serviceExe install
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the NalamDesk Server service.' }
}

if (Test-Path (Join-Path $dataDir 'security.json')) {
    Start-Service -Name 'NalamDeskServer'
    Write-Host 'NalamDesk Server is running.'
} else {
    Write-Host ''
    Write-Host 'NalamDesk Server is installed. In a new elevated PowerShell, create the vault:'
    Write-Host '  nalamdesk-server init --clinic-name "Your Clinic"'
    Write-Host 'or move a desktop clinic here:'
    Write-Host '  nalamdesk-server import C:\path\to\backup.ndbackup'
    Write-Host 'then start it:  Start-Service NalamDeskServer'
}
