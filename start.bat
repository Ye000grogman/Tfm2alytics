@echo off
rem Starts the Tfm2alytics site and keeps it updated from your saves.
cd /d "%~dp0"
set PY=python
where py >nul 2>nul && set PY=py -3
%PY% --version >nul 2>nul || (
  echo Python was not found. Install Python 3.10 or newer from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" during setup. See INSTALL.md.
  pause
  exit /b 1
)
%PY% -m tfm2alytics.serve %*
pause
