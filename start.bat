@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Первый запуск: создаю окружение...
  python -m venv .venv || goto :error
  .venv\Scripts\python -m pip install -r requirements.txt || goto :error
)
.venv\Scripts\python app.py %*
goto :eof
:error
echo Ошибка. Проверьте, что установлен Python 3.10+ ^(python.org^).
pause
