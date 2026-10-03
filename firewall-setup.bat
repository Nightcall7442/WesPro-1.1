@echo off
rem Правила брандмауэра Windows для программы клуба. Запускает его
rem start-club.bat с правами администратора - Windows спросит разрешение
rem один раз; можно запустить и вручную: правой кнопкой - "Запуск от имени
rem администратора".
rem   TCP 8000            - вход в программу с телефонов, планшетов, ноутбуков;
rem   UDP 6666,6667,7000  - реле Tuya/MOES сообщают о себе в сети.
rem Правила действуют во всех сетевых профилях (домашняя, рабочая,
rem общественная): иначе в "общественной" сети ничего не открывается.

net session >nul 2>&1
if errorlevel 1 (
  echo Нужны права администратора: правой кнопкой - "Запуск от имени администратора".
  pause
  exit /b 1
)
call :rule "Billiards Club 8000" TCP "8000"
call :rule "Billiards Club Tuya" UDP "6666,6667,7000"
exit /b 0

:rule
netsh advfirewall firewall show rule name=%1 >nul 2>&1
if errorlevel 1 (
  netsh advfirewall firewall add rule name=%1 dir=in action=allow protocol=%2 localport=%~3 profile=any >nul
) else (
  netsh advfirewall firewall set rule name=%1 new profile=any enable=yes >nul
)
exit /b 0
