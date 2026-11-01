@echo off
rem NalamDesk Server launcher. Uses the bundled Node runtime when present.
setlocal
set "ROOT=%~dp0.."
set "NODE=%ROOT%\runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
if not defined NALAMDESK_CONFIG if exist "%ProgramData%\NalamDesk\server\server.json" set "NALAMDESK_CONFIG=%ProgramData%\NalamDesk\server\server.json"
"%NODE%" "%ROOT%\app\dist\server\server\headless\main.js" %*
exit /b %ERRORLEVEL%
