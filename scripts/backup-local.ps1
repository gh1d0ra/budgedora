# Weekly off-Cloudflare backup: exports the live D1 database to a dated .sql file
# in "Documents\Budgedora Backups" and keeps the newest 52 files (about a year).
# Registered as a Windows scheduled task by scripts/install-backup-task.ps1.
$ErrorActionPreference = 'Stop'
$dir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Budgedora Backups'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd'
$out = Join-Path $dir "budgedora-$stamp.sql"
$log = Join-Path $dir 'backup.log'

$wrangler = (Get-Command wrangler.cmd -ErrorAction SilentlyContinue).Source
if (-not $wrangler) { $wrangler = Join-Path $env:APPDATA 'npm\wrangler.cmd' }

Set-Location (Split-Path $PSScriptRoot -Parent)
& $wrangler d1 export budgedora --remote --output $out *>> $log
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $out) -or (Get-Item $out).Length -lt 100) {
  Add-Content $log "$(Get-Date -Format s) FAILED (exit $LASTEXITCODE)"
  exit 1
}
Add-Content $log "$(Get-Date -Format s) OK $out ($((Get-Item $out).Length) bytes)"

Get-ChildItem $dir -Filter 'budgedora-*.sql' | Sort-Object Name -Descending | Select-Object -Skip 52 |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Confirm:$false }
