# Back up Bookshelf automatically every day (runs at the set time, or at next login if the PC was off).
#   Install:   powershell -ExecutionPolicy Bypass -File scripts\install-backup.ps1 [-Time 02:00]
#   Remove:    powershell -ExecutionPolicy Bypass -File scripts\install-backup.ps1 -Remove
# Backups go to $env:BOOKSHELF_BACKUP_DIR (set in .env) or data\backups. Point it at another drive
# or a cloud-synced folder for real protection.
param([switch]$Remove, [string]$Time = "02:00")

$taskName = "Bookshelf Backup"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed the '$taskName' scheduled task."
    return
}

$projectDir = Split-Path -Parent $PSScriptRoot
$uv = (Get-Command uv -ErrorAction Stop).Source

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"Set-Location '$projectDir'; & '$uv' run python -m app.backup`""
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Daily Bookshelf backup" -Force | Out-Null

Write-Host "Installed. Bookshelf will be backed up daily at $Time."
Write-Host "Run now with:  Start-ScheduledTask -TaskName '$taskName'"
