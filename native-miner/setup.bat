@echo off
echo ============================================
echo   Native Python Miner - Setup
echo ============================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found!
    echo Download from: https://www.python.org/downloads/
    pause
    exit /b 1
)

echo Installing requirements...
pip install websocket-client

if errorlevel 1 (
    echo.
    echo ERROR: Failed to install websocket-client
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Setup complete! Run: start_miner.bat
echo ============================================
pause
