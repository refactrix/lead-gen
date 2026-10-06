@echo off
rem Double-click to find new leads, audit them and draft emails on this PC.
rem Nothing is sent. See run-leads.ps1 for the steps.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-leads.ps1"
echo.
pause
