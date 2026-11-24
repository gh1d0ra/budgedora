# Registers a weekly Windows scheduled task (Sundays 8 PM, or as soon as the PC is on afterwards)
# that runs scripts/backup-local.ps1. Re-running replaces the task.
$script = Join-Path $PSScriptRoot 'backup-local.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 8pm
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'Budgedora weekly backup' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Exports the Budgedora Cloudflare D1 database to Documents\Budgedora Backups' -Force | Out-Null
Write-Output 'Registered: Budgedora weekly backup (Sundays 8 PM)'
