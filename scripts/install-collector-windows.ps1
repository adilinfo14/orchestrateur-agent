# Installe le collecteur comme tâche planifiée de l'utilisateur (au démarrage de session, relance auto).
# Usage (PowerShell, depuis le dossier du dépôt) : powershell -ExecutionPolicy Bypass -File scripts\install-collector-windows.ps1
# Désinstallation : Unregister-ScheduledTask -TaskName "AgentCommandCenterCollector" -Confirm:$false
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$log = Join-Path $HOME '.acc\collector.log'
New-Item -ItemType Directory -Force -Path (Join-Path $HOME '.acc') | Out-Null

# cmd /c permet la redirection du journal ; la fenêtre reste masquée.
$cmdArgs = "/c set NODE_NO_WARNINGS=1 && `"$node`" `"$repo\apps\collector\src\cli.ts`" run >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdArgs -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
Register-ScheduledTask -TaskName 'AgentCommandCenterCollector' -Action $action -Trigger $trigger -Settings $settings -Description 'Agent Command Center - collecteur Claude Code' -Force | Out-Null
Start-ScheduledTask -TaskName 'AgentCommandCenterCollector'
Write-Host "Collecteur installé. Journal : $log"
