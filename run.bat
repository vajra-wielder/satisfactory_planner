@echo off
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
    .venv\Scripts\python.exe app.py
) else if exist "venv\Scripts\python.exe" (
    venv\Scripts\python.exe app.py
) else (
    echo Could not find a virtual environment.
    echo Expected .venv or venv folder in the project directory.
    pause
    exit /b 1
)
