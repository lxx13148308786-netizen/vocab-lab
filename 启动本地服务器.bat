@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title AI News Vocab - Local Server

rem ============ 1. 探测可用的 Python 解释器 ============
set "PY_CMD="
where python >nul 2>nul
if not errorlevel 1 set "PY_CMD=python"
if not defined PY_CMD (
  where py >nul 2>nul
  if not errorlevel 1 set "PY_CMD=py -3"
)
if not defined PY_CMD (
  if exist "D:\IDLE\python.exe" set "PY_CMD=D:\IDLE\python.exe"
)
if not defined PY_CMD (
  if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PY_CMD=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
)
if not defined PY_CMD (
  echo [错误] 没有找到 Python，无法启动服务器。
  echo 请先安装 Python，并勾选 Add Python to PATH。
  echo.
  pause
  exit /b 1
)

echo ============================================
echo   AI 新闻背单词 - 本地服务器
echo ============================================
echo 服务目录: %CD%
echo 解释器  : %PY_CMD%
echo 访问地址: http://localhost:8000
echo AI 代理 : http://127.0.0.1:8787  （绕过预览环境 CSP 用，可不开）
echo.

rem ============ 2. 后台启动 AI 转发代理（8787）============
if exist "proxy_server.py" (
  start "AI News Vocab Proxy" /min cmd /c "%PY_CMD% proxy_server.py"
) else (
  echo [提示] 没找到 proxy_server.py，跳过 AI 代理（将直连 API）。
)

rem ============ 2b. 后台启动 python -m http.server 8000 ============
start "AI News Vocab Server" /min cmd /c "%PY_CMD% -m http.server 8000"

rem ============ 3. 等端口就绪后打开默认浏览器 ============
set "PORT_READY="
for /l %%i in (1,1,15) do (
  netstat -an | findstr /r /c:":8000 .*LISTENING" >nul 2>&1
  if not errorlevel 1 (
    set "PORT_READY=1"
    goto :OPEN_BROWSER
  )
  timeout /t 1 /nobreak >nul 2>&1
)

:OPEN_BROWSER
if not defined PORT_READY (
  echo [警告] 15 秒内没检测到 8000 端口，可能是端口已被占用或 Python 启动失败。
  echo        仍会尝试打开浏览器；若打不开，请关掉占用 8000 端口的程序后重试。
) else (
  echo 服务器已就绪。
)
start "" http://localhost:8000
echo 已用默认浏览器打开 http://localhost:8000
echo.
echo 停止服务：关掉标题为 "AI News Vocab Server" / "AI News Vocab Proxy" 的
echo           最小化窗口，或在其中按 Ctrl+C。
echo.
pause
