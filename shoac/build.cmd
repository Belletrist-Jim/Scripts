@echo off
REM shoac : Windows 下构建（需要已安装 Node.js）
REM 用法: 双击本文件，或在 cmd/PowerShell 里执行 build.cmd
cd /d "%~dp0"
node build.mjs %*
pause
