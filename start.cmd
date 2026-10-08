@echo off
REM Arranque en modo produccion: APP_BASE_URL se define en .env
set NODE_ENV=production
node server.js
