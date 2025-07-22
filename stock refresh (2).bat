@echo off
:: Get the directory where this .bat file is located
set "SCRIPT_DIR=%~dp0"

:: Check if Python is installed
python --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo Python is not installed. Installing Python...
    powershell -Command "& {Start-Process 'https://www.python.org/ftp/python/3.11.0/python-3.11.0-amd64.exe' -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1' -Wait}"
    echo Python installed successfully. Please restart your terminal and run this script again.
    exit /b
)

:: Run the Python script from the same directory as this .bat file
python "%SCRIPT_DIR%i2.py"

