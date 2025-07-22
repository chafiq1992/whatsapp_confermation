@echo off
REM === Activate venv and start FastAPI backend ===
start cmd /k "cd /d %~dp0backend && call venv\Scripts\activate && uvicorn main:app --reload --port 5000"
timeout /t 2

REM === Start ngrok (make sure ngrok.exe is in PATH or same folder) ===
start cmd /k "cd /d %~dp0 && ngrok http 5000"
timeout /t 2

REM === Start React frontend ===
start cmd /k "cd /d %~dp0frontend && npm start"
