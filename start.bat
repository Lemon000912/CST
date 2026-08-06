@echo off
chcp 65001 >nul
title QuantumPinnacle（量子巅）- 材料AI知识库系统

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║     QuantumPinnacle（量子巅）- 材料AI知识库系统        ║
echo ╚══════════════════════════════════════════════════════════╝
echo.
echo   [1/2] 启动 Node API 服务 (端口 8787) ...
start "QP-API" cmd /c "node backend\index.js"
timeout /t 3 /nobreak >nul

echo   [2/2] 启动前端开发服务器 (端口 5173) ...
start "QP-Client" cmd /c "cd /d %~dp0 && npx vite --config frontend/vite.config.ts --host 127.0.0.1"
timeout /t 5 /nobreak >nul

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║  ✅ 系统启动完成！                                     ║
echo ╠══════════════════════════════════════════════════════════╣
echo ║  用户端:  http://localhost:5173                         ║
echo ║  管理端:  http://localhost:8787/admin                   ║
echo ║  API文档: http://localhost:8787/api/health              ║
echo ║                                                          ║
echo ║  管理端默认账号: admin / TestAdmin_888                   ║
echo ╚══════════════════════════════════════════════════════════╝
echo.
echo  按任意键退出（服务将继续在后台运行）...
pause >nul
