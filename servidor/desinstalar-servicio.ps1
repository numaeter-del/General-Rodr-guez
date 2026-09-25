# Detiene y quita la tarea programada. NO borra la base de datos ni los respaldos.
$nombre = 'Red Central de Datos'
Stop-ScheduledTask -TaskName $nombre -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $nombre -Confirm:$false -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName $nombre -ErrorAction SilentlyContinue
Write-Host 'Servicio quitado. Los datos y respaldos siguen en su lugar.'
