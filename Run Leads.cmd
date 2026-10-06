@echo off
rem Double-click to find new leads on this PC (OpenStreetMap, then Google Maps).
rem Auditing and drafts run automatically online. See run-leads.ps1.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-leads.ps1"
echo.
pause
