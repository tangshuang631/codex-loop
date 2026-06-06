@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "ROOT=%~dp0"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\start-codex-loop.ps1" %*
exit /b %errorlevel%
