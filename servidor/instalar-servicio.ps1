# Red Central de Datos: instalación como servicio en Windows.
# Ejecutar en PowerShell COMO ADMINISTRADOR, dentro de la carpeta "servidor":
#     powershell -ExecutionPolicy Bypass -File .\instalar-servicio.ps1
#
# Hace tres cosas:
#   1. Crea una tarea programada que inicia el sistema al prender el servidor y lo reinicia si se cae.
#   2. Restringe las carpetas de datos, respaldos y la configuración: solo SYSTEM y Administradores de Windows.
#   3. Abre el puerto configurado en el Firewall de Windows.

$ErrorActionPreference = 'Stop'
$carpeta = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $carpeta

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'No se encontró Node.js. Instalá la versión LTS desde https://nodejs.org y volvé a ejecutar este script.' }
$version = (& $node -p "process.versions.node")
Write-Host "Node.js $version en $node"

# Configuración: si no existe, se crea con los valores por defecto.
if (-not (Test-Path 'config.json')) { & $node -e "require('./lib/config').cargarConfig()" }
$config = Get-Content 'config.json' -Raw | ConvertFrom-Json
$puerto = $config.puerto

# 1) Tarea programada (inicio automático + reinicio ante fallas)
$nombre = 'Red Central de Datos'
$accion = New-ScheduledTaskAction -Execute $node -Argument 'servidor.js' -WorkingDirectory $carpeta
$disparador = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $disparador -Principal $principal -Settings $ajustes -Force | Out-Null
Write-Host "Tarea programada '$nombre' creada."

# 2) Permisos: solo SYSTEM (*S-1-5-18) y el grupo Administradores (*S-1-5-32-544)
foreach ($d in @('datos', 'respaldos')) { if (-not (Test-Path $d)) { New-Item -ItemType Directory $d | Out-Null } }
foreach ($ruta in @('datos', 'respaldos')) {
  icacls $ruta /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
}
icacls 'config.json' /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
Write-Host 'Permisos restringidos en datos, respaldos y config.json.'

# 3) Firewall
if (-not (Get-NetFirewallRule -DisplayName $nombre -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $nombre -Direction Inbound -Protocol TCP -LocalPort $puerto -Action Allow | Out-Null
}
Write-Host "Puerto $puerto habilitado en el Firewall."

Start-ScheduledTask -TaskName $nombre
Start-Sleep -Seconds 3
Write-Host ''
Write-Host "Listo. El sistema quedó funcionando en el puerto $puerto."
Write-Host 'Si todavía no hay usuarios, ejecutar crear-admin.bat.'
