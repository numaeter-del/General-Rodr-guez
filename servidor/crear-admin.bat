@echo off
rem Crea el primer usuario Administrador (se usa una sola vez).
cd /d "%~dp0"
node herramientas\crear-admin.js
pause
