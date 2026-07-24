$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$configPath = Join-Path $root 'data\config.json'
$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$time = if ($config.scheduleTime) { [string]$config.scheduleTime } else { '08:30' }

if ($time -notmatch '^\d{2}:\d{2}$') {
  throw "Invalid scheduleTime in data\config.json: $time"
}

$taskName = 'PDKeywordReporterDaily'
$node = (Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)
if (-not $node) {
  $node = (Get-Command node).Source
}
$args = "src/server.js --once"
$action = New-ScheduledTaskAction -Execute $node -Argument $args -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($time, 'HH:mm', $null))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Daily HTTP crawl for Tencent Channel keyword report.' -Force | Out-Null

Write-Host "Installed scheduled task '$taskName' at $time."
