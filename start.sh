#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Первый запуск: создаю окружение..."
  python3 -m venv .venv
  .venv/bin/python -m pip install -r requirements.txt
fi
exec .venv/bin/python app.py "$@"
