@echo off
chcp 65001 >nul
title manim-ui
cd /d "%~dp0"

echo.
echo   正在启动本地服务...
echo.

where python >nul 2>nul
if %errorlevel%==0 (
    set PY=python
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        set PY=py -3
    ) else (
        echo   [错误] 未检测到 Python。
        echo   请先安装 Python 3.8 或更高版本：https://www.python.org/downloads/
        echo   安装时请勾选 "Add Python to PATH"
        echo.
        pause
        exit /b 1
    )
)

%PY% server\serve.py %*

if %errorlevel% neq 0 pause
