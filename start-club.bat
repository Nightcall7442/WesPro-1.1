@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Бильярдный клуб

rem Один файл на всё: проверяет Node.js, ставит библиотеки, настраивает
rem брандмауэр (Windows один раз спросит разрешение), запускает программу,
rem открывает браузер и проверяет, отвечают ли реле над столами.

rem --- Node.js -------------------------------------------------------------
rem Нужен Node.js 22.13 или новее. Нет его - предлагаем поставить одной
rem командой (winget есть в Windows 10 и 11), иначе открываем сайт.
where node >nul 2>&1
if errorlevel 1 (
  echo Не найден Node.js - без него программа не запустится.
  goto offer_node
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo Установлен старый Node.js - нужна версия 22.13 или новее.
  goto offer_node
)
goto node_ok

:offer_node
where winget >nul 2>&1
if errorlevel 1 (
  echo Скачайте версию LTS с сайта nodejs.org, установите и запустите этот файл снова.
  start "" https://nodejs.org
  pause
  exit /b 1
)
choice /c YN /m "Установить Node.js сейчас? Y - да, N - нет"
if errorlevel 2 exit /b 1
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo Готово. Закройте это окно и запустите start-club.bat ещё раз.
pause
exit /b 0

:node_ok

rem --- Библиотеки программы ------------------------------------------------
rem Ставим при первом запуске и после каждого обновления программы - когда
rem package-lock.json новее установленного. Раньше ставили только один раз,
rem и после обновления новые библиотеки (например, для реле Tuya) не
rem появлялись.
node -e "const fs=require('fs');try{process.exit(fs.statSync('node_modules/.package-lock.json').mtimeMs>=fs.statSync('package-lock.json').mtimeMs?0:1)}catch{process.exit(1)}"
if errorlevel 1 (
  echo Установка библиотек программы, подождите...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [!] Не удалось установить библиотеки. Проверьте интернет и запустите файл снова.
    pause
    exit /b 1
  )
)

rem --- Брандмауэр Windows --------------------------------------------------
rem Два правила во всех сетевых профилях: TCP 8000 - вход с телефонов,
rem планшетов и ноутбуков; UDP 6666, 6667, 7000 - реле Tuya/MOES сообщают о
rem себе (поиск реле и слежение за их адресом). Заводит их firewall-setup.bat:
rem уже есть права администратора - сразу, нет - Windows один раз спросит
rem разрешение, дальше правила уже на месте и вопроса не будет.
net session >nul 2>&1
if not errorlevel 1 (
  call "%~dp0firewall-setup.bat"
  goto firewall_check
)
call :firewall_rules_present
if "%FW_OK%"=="1" goto firewall_check
echo Настройка брандмауэра: Windows спросит разрешение - нажмите "Да".
powershell -NoProfile -Command "try { Start-Process -FilePath '%~dp0firewall-setup.bat' -Verb RunAs -Wait } catch { exit 1 }" >nul 2>&1

:firewall_check
call :firewall_rules_present
if "%FW_OK%"=="1" (echo [+] Брандмауэр настроен.) else (set NEED_ADMIN=1)

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
echo Реле над столами:
node src/check-relays.js
echo.

if defined NEED_ADMIN (
  echo ==========================================================
  echo   ВНИМАНИЕ: правила брандмауэра не добавлены - разрешение
  echo   не дали. С телефона программа может не открываться, а
  echo   поиск реле Tuya в сети не будет работать. Запустите этот
  echo   файл ещё раз и нажмите "Да" в окне Windows.
  echo ==========================================================
  echo.
)

pause
exit /b 0

rem Есть ли оба правила брандмауэра: FW_OK=1 - да.
:firewall_rules_present
set FW_OK=1
netsh advfirewall firewall show rule name="Billiards Club 8000" >nul 2>&1 || set FW_OK=0
netsh advfirewall firewall show rule name="Billiards Club Tuya" >nul 2>&1 || set FW_OK=0
exit /b 0
