@echo off
set "APPDIR=%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

rem Кладём в автозагрузку скрипт, который тихо (без окна) поднимает сервер
> "%STARTUP%\billiards-club.vbs" echo Set sh = CreateObject("WScript.Shell") : sh.CurrentDirectory = "%APPDIR:~0,-1%" : sh.Run "cmd /c npm start", 0, False

echo.
echo Готово! Сервер клуба будет запускаться сам при входе в Windows.
echo Открывайте в браузере: http://127.0.0.1:8000
echo Отменить автозапуск: autostart-remove.bat
echo.
pause
