@echo off
chcp 65001 >nul
title manim-ui
cd /d "%~dp0"

echo.
echo   正在启动本地服务...
echo.

rem ── 1. 绿色版自带的便携 Python 优先（解压即用，不依赖系统环境）──
if exist "%~dp0runtime\python\python.exe" (
    set "PY=%~dp0runtime\python\python.exe"
    goto run
)

rem ── 2. 系统里装的 Python ──
where python >nul 2>nul
if %errorlevel%==0 (
    set PY=python
    goto run
)
where py >nul 2>nul
if %errorlevel%==0 (
    set PY=py -3
    goto run
)

echo   [错误] 未检测到 Python。
echo   如果这是绿色版（解压目录里有 runtime 文件夹），请确认 runtime\python\python.exe 存在。
echo   否则请先安装 Python 3.8 或更高版本：https://www.python.org/downloads/
echo   安装时请勾选 "Add Python to PATH"
echo.
pause
exit /b 1

:run
%PY% server\serve.py %*

if %errorlevel% neq 0 pause
