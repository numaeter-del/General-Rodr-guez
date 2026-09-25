@echo off
rem Inicia la Red Central de Datos en esta ventana (para probar).
rem Para dejarlo funcionando siempre, usar instalar-servicio.ps1
cd /d "%~dp0"
node servidor.js
pause
