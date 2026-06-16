@echo off
title Conviction Calibration

cd /d "%~dp0"

echo.
echo ========================================
echo   Conviction Calibration
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Please install Node.js 18+ from https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo [Check] Node version:
node -v
echo.

if not exist "run-calibration.mjs" (
    echo [ERROR] run-calibration.mjs not found.
    echo Put this .bat in the project folder, same level as run-calibration.mjs
    echo.
    pause
    exit /b 1
)
if not exist "export-klinemap.mjs" (
    echo [ERROR] export-klinemap.mjs not found.
    echo.
    pause
    exit /b 1
)
if not exist "js\conviction.js" (
    echo [ERROR] js\conviction.js not found.
    echo Make sure js folder has conviction.js and conviction-calib.js
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   STEP 1 / 2 : Fetch market K-line
echo ========================================
echo.
node export-klinemap.mjs
if errorlevel 1 (
    echo.
    echo [ERROR] Fetch K-line failed. See messages above.
    echo.
    pause
    exit /b 1
)

if not exist "klineMap.json" (
    echo.
    echo [ERROR] klineMap.json not produced.
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   STEP 2 / 2 : Run calibration
echo   ^(may take a few minutes^)
echo ========================================
echo.
node run-calibration.mjs klineMap.json
if errorlevel 1 (
    echo.
    echo [ERROR] Calibration failed. See messages above.
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   DONE
echo ========================================
echo.
echo Report file: CONVICTION_CALIB_DATE_TIME.md
echo See "Stage 5" at the bottom of the report:
echo   GREEN pass = params can be frozen, C can go live
echo   RED  fail = C not live yet
echo.
echo Paste the report to Claude for review.
echo.

for /f "delims=" %%i in ('dir /b /od CONVICTION_CALIB_*.md 2^>nul') do set "LATEST=%%i"
if defined LATEST (
    echo Opening report: %LATEST%
    start "" "%LATEST%"
)

echo.
pause
