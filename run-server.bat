@echo off
rem Okno servera kluba: derzhit programmu zapushchennoy i podnimaet ee
rem zanovo, esli ona sama poprosila perezapusk.
rem
rem Knopka "Perezapustit server" v nastroykah zavershaet programmu kodom 7 -
rem tolko takoy vyhod cikl perezapuskaet. Obychnyy vyhod (zakryli okno,
rem oshibka) - net, inache slomannaya programma krutilas by vechno.

setlocal
cd /d "%~dp0"
title Сервер клуба

:loop
call npm start
if "%errorlevel%"=="7" (
  echo.
  echo Перезапуск программы по команде из настроек...
  echo.
  timeout /t 2 /nobreak >nul
  goto loop
)

echo.
echo Сервер остановлен. Это окно можно закрыть.
pause
