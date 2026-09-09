@echo off
setlocal
cd /d "%~dp0"
title Аккаунт разработчика

if not exist node_modules (
  echo Сначала запустите start-club.bat - он установит зависимости.
  echo.
  pause
  exit /b 1
)

echo ==========================================================
echo   Создание аккаунта РАЗРАБОТЧИКА
echo ==========================================================
echo.
echo   У разработчика полный доступ всегда: он не зависит от
echo   настроек прав. Пароль храните отдельно и сотрудникам
echo   не давайте - для работы есть владелец, управляющий,
echo   администратор и кассир.
echo.
set "DEV_LOGIN="
set /p DEV_LOGIN=Логин (Enter - будет "dev"): 
if "%DEV_LOGIN%"=="" set DEV_LOGIN=dev

set "DEV_PASS="
set /p DEV_PASS=Пароль (Enter - придумает программа): 

echo.
if "%DEV_PASS%"=="" (
  call npm run --silent add-user -- --role developer --login "%DEV_LOGIN%" --name "Разработчик"
) else (
  call npm run --silent add-user -- --role developer --login "%DEV_LOGIN%" --name "Разработчик" --password "%DEV_PASS%"
)

echo Если сервер клуба уже работает - перезапускать его не нужно,
echo аккаунт заработает сразу. Просто войдите под ним.
echo.
pause
