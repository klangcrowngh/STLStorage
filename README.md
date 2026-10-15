# STL Хранилище

Веб-хранилище STL-моделей для локальной сети: проекты с тегами, миниатюры моделей, 3D-просмотр в браузере, описания, комментарии, профили пользователей.

- Бэкенд: Python 3.10+ (Flask + Waitress), база SQLite. Отдельный сервер БД не нужен.
- Фронтенд: обычные HTML/JS, three.js лежит в проекте. **Интернет не нужен.**
- Миниатюры рендерятся в браузере при загрузке файла, на сервере ничего рендерить не надо.

---

## Перенос на сервер

Скопируйте папку проекта на сервер **без** `.venv/` и `data/` (окружение создаётся заново на месте,
а `data/` — это рабочие данные; при первом запуске папка создастся пустой).

## Быстрый старт (Docker), рекомендуется

```bash
docker compose up -d --build
```

Сайт откроется по адресу `http://<IP-сервера>:8000`.

Все данные хранятся в папке `./data` рядом с `docker-compose.yml`.
Порт и настройки меняются в `docker-compose.yml`.

Обновление после изменений в коде:

```bash
docker compose up -d --build
```

## Запуск без Docker

Нужен Python 3.10 или новее.

**Linux:**

```bash
./start.sh
```

**Windows:** запустить `start.bat`.

При первом запуске скрипт сам создаст виртуальное окружение `.venv` и установит зависимости (нужен доступ к PyPI, либо заранее скачанные пакеты из `requirements.txt`).

### Автозапуск на Linux (systemd)

`/etc/systemd/system/stl-storage.service`:

```ini
[Unit]
Description=STL Storage
After=network.target

[Service]
WorkingDirectory=/opt/stl-storage
ExecStart=/opt/stl-storage/.venv/bin/python app.py
Environment=STL_PORT=8000
Environment=STL_DATA_DIR=/opt/stl-storage/data
Restart=always
User=stl

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now stl-storage
```

(Перед этим один раз выполнить `./start.sh`, чтобы создалось `.venv`, затем остановить его через Ctrl+C.)

### Windows

Чтобы сервер стартовал вместе с системой, можно добавить `start.bat` в «Планировщик заданий» (триггер: при запуске системы)
или установить его как службу через [NSSM](https://nssm.cc/). Не забудьте открыть порт в брандмауэре:

```powershell
netsh advfirewall firewall add rule name="STL Storage" dir=in action=allow protocol=TCP localport=8000
```

---

## Настройки (переменные окружения)

| Переменная               | По умолчанию | Что делает                                              |
|--------------------------|--------------|---------------------------------------------------------|
| `STL_PORT`               | `8000`       | Порт веб-сервера                                        |
| `STL_HOST`               | `0.0.0.0`    | Адрес, на котором слушает сервер (0.0.0.0 — вся сеть)   |
| `STL_DATA_DIR`           | `./data`     | Папка с базой, STL-файлами и миниатюрами                |
| `STL_MAX_UPLOAD_MB`      | `1024`       | Максимальный размер одного загружаемого файла, МБ       |
| `STL_ALLOW_REGISTRATION` | `1`          | `0` — новые пользователи не могут регистрироваться сами |
| `STL_THREADS`            | `16`         | Число потоков обработки запросов                        |

## Пользователи

- Пользователи регистрируются сами на странице входа.
- **Первый зарегистрированный пользователь становится администратором.**
- Редактировать название, теги и описание может любой пользователь. Удалять проекты, модели и комментарии может только их автор или администратор.

Сервисные команды запускаются на сервере (в Docker нужно добавить префикс `docker compose exec stl-storage`):

```bash
python app.py users                                # список пользователей
python app.py reset-password <логин> <новый_пароль>  # сброс забытого пароля
python app.py make-admin <логин>                   # выдать права администратора
```

Пример для Docker:

```bash
docker compose exec stl-storage python app.py reset-password ivan 1234
```

## Резервное копирование

Всё хранится в одной папке `data/`:

```
data/
  stl.db       — база (проекты, модели, теги, комментарии, пользователи)
  files/       — STL-файлы
  thumbs/      — миниатюры
  secret.key   — ключ сессий (если удалить, всем придётся войти заново)
```

Для бэкапа достаточно скопировать папку `data/`. Лучше делать это при остановленном сервере
или скопировать базу командой `sqlite3 data/stl.db ".backup backup.db"`.

## Если ставите за nginx

Увеличьте лимит размера запроса, иначе большие STL не загрузятся:

```nginx
client_max_body_size 1024m;
proxy_request_buffering off;
proxy_read_timeout 300s;
```

## Безопасность

Сайт рассчитан на доверенную локальную сеть: пароли хранятся в виде хешей, но соединение идёт по HTTP.
**Не открывайте его в интернет без HTTPS** (например, через reverse proxy с сертификатом).

## Структура проекта

```
app.py               — сервер и API
static/index.html    — страница
static/app.js        — интерфейс
static/viewer.js     — 3D-просмотр и генерация миниатюр
static/app.css       — стили
static/vendor/three/ — three.js r160 (локальная копия)
Dockerfile, docker-compose.yml, start.sh, start.bat
```
