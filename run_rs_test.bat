@echo off
title RS Rating IC Test (hist/adjclose)

cd /d "%~dp0"

echo.
echo ========================================
echo   RS Rating IC Test (hist adjclose)
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

if not exist "test-rs-ic.mjs" (
    echo [ERROR] test-rs-ic.mjs not found. Put this .bat in same folder.
    pause
    exit /b 1
)
if not exist "export-hist-klinemap.mjs" (
    echo [ERROR] export-hist-klinemap.mjs not found.
    pause
    exit /b 1
)

echo [STEP 1] Fetch market K-line from hist storage (with adjclose)...
echo.
node export-hist-klinemap.mjs
if errorlevel 1 (
    echo [ERROR] Fetch failed.
    pause
    exit /b 1
)

if not exist "klineMap.json" (
    echo [ERROR] klineMap.json not produced.
    pause
    exit /b 1
)

echo.
echo [STEP 2] Running RS IC test...
echo.
node test-rs-ic.mjs klineMap.json
if errorlevel 1 (
    echo [ERROR] Test failed.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   DONE - see RS_IC_TEST_*.md
echo ========================================
echo.

for /f "delims=" %%i in ('dir /b /od RS_IC_TEST_*.md 2^>nul') do set "LATEST=%%i"
if defined LATEST (
    echo Opening: %LATEST%
    start "" "%LATEST%"
)

pause
