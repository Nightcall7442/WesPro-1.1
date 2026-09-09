@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Бильярдный клуб

if not exist node_modules (
  echo Первый запуск: установка зависимостей, подождите...
  call npm install
)

rem --- Брандмауэр Windows -------------------------------------------------
rem Разрешаем входящие на порт 8000 во ВСЕХ сетевых профилях (домашняя,
rem рабочая, общественная). Раньше правило добавлялось молча: без прав
rem администратора оно не создавалось совсем, из-за этого клуб открывался
rem с одного устройства и не открывался с другого.

net session >nul 2>&1
if errorlevel 1 (set IS_ADMIN=0) else (set IS_ADMIN=1)

netsh advfirewall firewall show rule name="Billiards Club 8000" >nul 2>&1
if errorlevel 1 (goto add_rule) else (goto widen_rule)

:add_rule
if "%IS_ADMIN%"=="0" (set NEED_ADMIN=1& goto firewall_done)
netsh advfirewall firewall add rule name="Billiards Club 8000" dir=in action=allow protocol=TCP localport=8000 profile=any >nul
if errorlevel 1 (echo [!] Не удалось добавить правило брандмауэра.) else (echo [+] Брандмауэр: порт 8000 разрешен для всех сетей.)
goto firewall_done

:widen_rule
rem Правило есть, но могло быть создано только для домашней сети -
rem расширяем на все профили, чтобы работало и в "общественной".
if "%IS_ADMIN%"=="1" netsh advfirewall firewall set rule name="Billiards Club 8000" new profile=any enable=yes >nul 2>&1

:firewall_done

rem --- Сервер -------------------------------------------------------------
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('127.0.0.1',8000)).Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 goto opened

rem Zapusk cherez run-server.bat: on podnimet programmu zanovo, esli
rem nazhat "Perezapustit server" v nastroykah.
start "Сервер клуба" /min cmd /c "run-server.bat"
timeout /t 3 /nobreak >nul

:opened
start "" http://127.0.0.1:8000

echo.
echo ==========================================================
echo   Клуб запущен. Не закрывайте окно "Сервер клуба".
echo ==========================================================
echo.
echo На этом компьютере:
echo    http://127.0.0.1:8000
echo.
echo С телефона, планшета и ноутбука в той же сети:
node src/print-network.js
echo.
echo Подходит адрес, у которого первые три числа совпадают с адресом
echo устройства (на телефоне: Wi-Fi - сведения о сети - IP-адрес).
echo Все адреса всегда видны в программе: Настройки - Доступ с телефона.
echo.

if defined NEED_ADMIN (
  echo ==========================================================
  echo   ВНИМАНИЕ: правило брандмауэра не добавлено - нет прав.
  echo   Если с телефона или ноутбука не открывается: закройте окно
  echo   и запустите start-club.bat ПРАВОЙ кнопкой мыши, выбрав
  echo   "Запуск от имени администратора". Это нужно один раз.
  echo ==========================================================
  echo.
)

pause
