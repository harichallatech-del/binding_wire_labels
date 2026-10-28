@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node.js LTS from https://nodejs.org first, then run this again. & pause & exit /b 1)
if not exist node_modules\sql.js (echo First run: downloading sql.js, please wait... & call npm install --omit=dev --no-audit --no-fund)
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:3001"
node server.js
pause
