"""STL-хранилище: бэкенд (REST API + раздача фронтенда).

Данные лежат в STL_DATA_DIR (по умолчанию ./data):
  stl.db      — база SQLite (пользователи, проекты, модели, теги, комментарии)
  files/      — загруженные STL-файлы
  thumbs/     — миниатюры моделей (PNG, рендерятся в браузере при загрузке)
  secret.key  — ключ подписи сессий (создаётся автоматически)

Сервисные команды:
  python app.py                                — запустить сервер
  python app.py reset-password <логин> <пароль> — сменить пароль пользователю
  python app.py make-admin <логин>              — выдать права администратора
  python app.py users                          — список пользователей
"""
import json
import os
import secrets
import sqlite3
import sys
import tempfile
import time
import uuid
import zipfile
from datetime import timedelta
from functools import wraps
from pathlib import Path

from flask import Flask, g, jsonify, request, send_file, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("STL_DATA_DIR", BASE_DIR / "data")).resolve()
FILES_DIR = DATA_DIR / "files"
THUMBS_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "stl.db"
SECRET_PATH = DATA_DIR / "secret.key"

HOST = os.environ.get("STL_HOST", "0.0.0.0")
PORT = int(os.environ.get("STL_PORT", "8000"))
MAX_UPLOAD_MB = int(os.environ.get("STL_MAX_UPLOAD_MB", "1024"))
THREADS = int(os.environ.get("STL_THREADS", "16"))
ALLOW_REGISTRATION = os.environ.get("STL_ALLOW_REGISTRATION", "1") not in ("0", "false", "no")

MAX_THUMB_BYTES = 5 * 1024 * 1024

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    login          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name           TEXT NOT NULL,
    password_hash  TEXT NOT NULL,
    is_admin       INTEGER NOT NULL DEFAULT 0,
    created_at     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    created_by  INTEGER REFERENCES users(id),
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS project_tags (
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL,
    PRIMARY KEY (project_id, tag)
);
CREATE TABLE IF NOT EXISTS models (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    file_name    TEXT NOT NULL,
    stored_name  TEXT NOT NULL,
    size         INTEGER NOT NULL,
    has_thumb    INTEGER NOT NULL DEFAULT 0,
    thumb_ver    INTEGER NOT NULL DEFAULT 0,
    uploaded_by  INTEGER REFERENCES users(id),
    updated_by   INTEGER REFERENCES users(id),
    created_at   REAL NOT NULL,
    updated_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS models_project ON models(project_id);
CREATE TABLE IF NOT EXISTS model_tags (
    model_id  INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (model_id, tag)
);
CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id    INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id),
    text        TEXT NOT NULL,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_model ON comments(model_id);
"""

app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="/static")
app.config.update(
    MAX_CONTENT_LENGTH=MAX_UPLOAD_MB * 1024 * 1024,
    PERMANENT_SESSION_LIFETIME=timedelta(days=60),
    SESSION_COOKIE_NAME="stl_session",
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_HTTPONLY=True,
)
app.json.ensure_ascii = False


def init_storage():
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    if not SECRET_PATH.exists():
        SECRET_PATH.write_text(secrets.token_hex(32))
    app.secret_key = SECRET_PATH.read_text().strip()
    con = sqlite3.connect(DB_PATH)
    try:
        con.execute("PRAGMA journal_mode = WAL")
        con.executescript(SCHEMA)
        con.commit()
    finally:
        con.close()


def db():
    if "db" not in g:
        con = sqlite3.connect(DB_PATH, timeout=30)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        g.db = con
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    con = g.pop("db", None)
    if con is not None:
        con.close()


# ---------- helpers ----------

class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify(error=e.message), e.status


@app.errorhandler(404)
def handle_404(_e):
    return jsonify(error="Не найдено"), 404


@app.errorhandler(413)
def handle_413(_e):
    return jsonify(error=f"Файл слишком большой (максимум {MAX_UPLOAD_MB} МБ)"), 413


def clean_text(value, limit):
    return value.strip()[:limit] if isinstance(value, str) else ""


def clean_tags(raw):
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = raw.split(",")
    if not isinstance(raw, list):
        return []
    out = []
    for t in raw:
        if not isinstance(t, str):
            continue
        t = " ".join(t.split()).lower()[:40]
        if t and t not in out:
            out.append(t)
    return out[:30]


def json_body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Ожидался JSON-объект")
    return data


def get_row(table, row_id):
    row = db().execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,)).fetchone()
    if row is None:
        raise ApiError("Не найдено", 404)
    return row


def set_tags(table, key, owner_id, tags):
    con = db()
    con.execute(f"DELETE FROM {table} WHERE {key} = ?", (owner_id,))
    con.executemany(f"INSERT INTO {table} ({key}, tag) VALUES (?, ?)", [(owner_id, t) for t in tags])


def tags_by_owner(table, key, where="", params=()):
    result = {}
    for r in db().execute(f"SELECT {key} AS owner, tag FROM {table} {where} ORDER BY tag", params):
        result.setdefault(r["owner"], []).append(r["tag"])
    return result


def users_by_id():
    if "users" not in g:
        g.users = {r["id"]: {"id": r["id"], "name": r["name"]} for r in db().execute("SELECT id, name FROM users")}
    return g.users


def user_ref(user_id):
    return users_by_id().get(user_id) if user_id else None


def thumb_url(row):
    return f"/api/models/{row['id']}/thumb?v={row['thumb_ver']}" if row["has_thumb"] else None


def touch_project(project_id):
    db().execute("UPDATE projects SET updated_at = ? WHERE id = ?", (time.time(), project_id))


def project_dict(row, tags, covers=None, model_count=0):
    return {
        "id": row["id"],
        "name": row["name"],
        "tags": tags,
        "covers": covers or [],
        "model_count": model_count,
        "created_by": user_ref(row["created_by"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def model_dict(row, tags, comment_count=0):
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "name": row["name"],
        "description": row["description"],
        "file_name": row["file_name"],
        "size": row["size"],
        "thumb": thumb_url(row),
        "tags": tags,
        "comment_count": comment_count,
        "uploaded_by": user_ref(row["uploaded_by"]),
        "updated_by": user_ref(row["updated_by"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def comment_dict(row):
    return {"id": row["id"], "author": user_ref(row["user_id"]), "text": row["text"], "created_at": row["created_at"]}


def model_with_tags(mid):
    tags = tags_by_owner("model_tags", "model_id", "WHERE model_id = ?", (mid,)).get(mid, [])
    return model_dict(get_row("models", mid), tags)


def remove_model_files(model_id, stored_name):
    for path in (FILES_DIR / stored_name, THUMBS_DIR / f"{model_id}.png"):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def save_thumbnail(model_id, upload):
    data = upload.read(MAX_THUMB_BYTES + 1)
    if len(data) > MAX_THUMB_BYTES or not data.startswith(b"\x89PNG"):
        return False
    (THUMBS_DIR / f"{model_id}.png").write_bytes(data)
    return True


# ---------- auth ----------

def current_user():
    if "user" not in g:
        uid = session.get("uid")
        g.user = db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone() if uid else None
    return g.user


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if current_user() is None:
            raise ApiError("Требуется вход", 401)
        return view(*args, **kwargs)
    return wrapper


def require_owner(owner_id):
    """Удалять может только автор записи или администратор."""
    user = current_user()
    if not (user["is_admin"] or (owner_id is not None and owner_id == user["id"])):
        raise ApiError("Удалить может только автор или администратор", 403)


def me_dict(row):
    return {"id": row["id"], "login": row["login"], "name": row["name"], "is_admin": bool(row["is_admin"])}


def start_session(user_id):
    session.clear()
    session.permanent = True
    session["uid"] = user_id


@app.get("/api/auth/me")
def auth_me():
    user = current_user()
    return jsonify(user=me_dict(user) if user else None, allow_registration=ALLOW_REGISTRATION)


@app.post("/api/auth/login")
def auth_login():
    data = json_body()
    login = clean_text(data.get("login"), 40)
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    row = db().execute("SELECT * FROM users WHERE login = ?", (login,)).fetchone()
    if row is None or not check_password_hash(row["password_hash"], password):
        raise ApiError("Неверный логин или пароль", 401)
    start_session(row["id"])
    return jsonify(user=me_dict(row))


@app.post("/api/auth/register")
def auth_register():
    if not ALLOW_REGISTRATION:
        raise ApiError("Регистрация отключена. Обратитесь к администратору.", 403)
    data = json_body()
    login = clean_text(data.get("login"), 40)
    name = clean_text(data.get("name"), 60) or login
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    if len(login) < 2 or any(c.isspace() for c in login):
        raise ApiError("Логин — минимум 2 символа, без пробелов")
    if len(password) < 4:
        raise ApiError("Пароль — минимум 4 символа")
    con = db()
    if con.execute("SELECT 1 FROM users WHERE login = ?", (login,)).fetchone():
        raise ApiError("Такой логин уже занят")
    is_first = con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    cur = con.execute(
        "INSERT INTO users (login, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)",
        (login, name, generate_password_hash(password), int(is_first), time.time()),
    )
    con.commit()
    start_session(cur.lastrowid)
    return jsonify(user=me_dict(get_row("users", cur.lastrowid))), 201


@app.post("/api/auth/logout")
def auth_logout():
    session.clear()
    return jsonify(ok=True)


@app.patch("/api/auth/me")
@login_required
def auth_update_me():
    data = json_body()
    user = current_user()
    con = db()
    if "name" in data:
        name = clean_text(data.get("name"), 60)
        if not name:
            raise ApiError("Имя не может быть пустым")
        con.execute("UPDATE users SET name = ? WHERE id = ?", (name, user["id"]))
    if data.get("new_password"):
        if not check_password_hash(user["password_hash"], str(data.get("password") or "")):
            raise ApiError("Текущий пароль указан неверно")
        if len(str(data["new_password"])) < 4:
            raise ApiError("Пароль — минимум 4 символа")
        con.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                    (generate_password_hash(str(data["new_password"])), user["id"]))
    con.commit()
    return jsonify(user=me_dict(get_row("users", user["id"])))


@app.get("/api/users")
@login_required
def list_users():
    rows = db().execute("SELECT id, name FROM users ORDER BY name COLLATE NOCASE").fetchall()
    return jsonify([{"id": r["id"], "name": r["name"]} for r in rows])


# ---------- frontend ----------

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# ---------- projects ----------

@app.get("/api/projects")
@login_required
def list_projects():
    con = db()
    rows = con.execute(
        "SELECT p.*, (SELECT COUNT(*) FROM models m WHERE m.project_id = p.id) AS model_count "
        "FROM projects p ORDER BY p.updated_at DESC"
    ).fetchall()
    tags = tags_by_owner("project_tags", "project_id")
    covers = {}
    for m in con.execute("SELECT id, project_id, has_thumb, thumb_ver FROM models WHERE has_thumb = 1 ORDER BY created_at DESC"):
        lst = covers.setdefault(m["project_id"], [])
        if len(lst) < 4:
            lst.append(thumb_url(m))
    return jsonify([project_dict(r, tags.get(r["id"], []), covers.get(r["id"]), r["model_count"]) for r in rows])


@app.post("/api/projects")
@login_required
def create_project():
    data = json_body()
    name = clean_text(data.get("name"), 120)
    if not name:
        raise ApiError("Введите название проекта")
    tags = clean_tags(data.get("tags"))
    now = time.time()
    con = db()
    cur = con.execute("INSERT INTO projects (name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)",
                      (name, current_user()["id"], now, now))
    set_tags("project_tags", "project_id", cur.lastrowid, tags)
    con.commit()
    return jsonify(project_dict(get_row("projects", cur.lastrowid), tags)), 201


@app.get("/api/projects/<int:pid>")
@login_required
def get_project(pid):
    con = db()
    row = get_row("projects", pid)
    models = con.execute("SELECT * FROM models WHERE project_id = ? ORDER BY created_at DESC", (pid,)).fetchall()
    mtags = tags_by_owner("model_tags", "model_id", "WHERE model_id IN (SELECT id FROM models WHERE project_id = ?)", (pid,))
    counts = {
        r["model_id"]: r["n"]
        for r in con.execute(
            "SELECT model_id, COUNT(*) AS n FROM comments WHERE model_id IN (SELECT id FROM models WHERE project_id = ?) GROUP BY model_id",
            (pid,),
        )
    }
    ptags = tags_by_owner("project_tags", "project_id", "WHERE project_id = ?", (pid,)).get(pid, [])
    result = project_dict(row, ptags, model_count=len(models))
    result["models"] = [model_dict(m, mtags.get(m["id"], []), counts.get(m["id"], 0)) for m in models]
    result["all_model_tags"] = [r["tag"] for r in con.execute("SELECT DISTINCT tag FROM model_tags ORDER BY tag")]
    return jsonify(result)


@app.patch("/api/projects/<int:pid>")
@login_required
def update_project(pid):
    get_row("projects", pid)
    data = json_body()
    con = db()
    if "name" in data:
        name = clean_text(data.get("name"), 120)
        if not name:
            raise ApiError("Название не может быть пустым")
        con.execute("UPDATE projects SET name = ? WHERE id = ?", (name, pid))
    if "tags" in data:
        set_tags("project_tags", "project_id", pid, clean_tags(data.get("tags")))
    touch_project(pid)
    con.commit()
    tags = tags_by_owner("project_tags", "project_id", "WHERE project_id = ?", (pid,)).get(pid, [])
    return jsonify(project_dict(get_row("projects", pid), tags))


@app.delete("/api/projects/<int:pid>")
@login_required
def delete_project(pid):
    row = get_row("projects", pid)
    require_owner(row["created_by"])
    con = db()
    files = con.execute("SELECT id, stored_name FROM models WHERE project_id = ?", (pid,)).fetchall()
    con.execute("DELETE FROM projects WHERE id = ?", (pid,))
    con.commit()
    for f in files:
        remove_model_files(f["id"], f["stored_name"])
    return jsonify(ok=True)


@app.get("/api/projects/<int:pid>/zip")
@login_required
def download_project_zip(pid):
    project = get_row("projects", pid)
    models = db().execute("SELECT file_name, stored_name FROM models WHERE project_id = ? ORDER BY created_at", (pid,)).fetchall()
    tmp = tempfile.TemporaryFile()
    used = set()
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=5) as zf:
        for m in models:
            path = FILES_DIR / m["stored_name"]
            if not path.exists():
                continue
            name, n = m["file_name"], 1
            while name.lower() in used:
                stem, dot, ext = m["file_name"].rpartition(".")
                name = f"{stem} ({n}).{ext}" if dot else f"{m['file_name']} ({n})"
                n += 1
            used.add(name.lower())
            zf.write(path, name)
    tmp.seek(0)
    safe = "".join(c for c in project["name"] if c not in '\\/:*?"<>|').strip() or "project"
    return send_file(tmp, mimetype="application/zip", as_attachment=True, download_name=f"{safe}.zip")


# ---------- models ----------

@app.post("/api/projects/<int:pid>/models")
@login_required
def upload_model(pid):
    get_row("projects", pid)
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        raise ApiError("Файл не передан")
    file_name = Path(upload.filename).name[:200]
    if not file_name.lower().endswith(".stl"):
        raise ApiError("Поддерживаются только файлы .stl")
    name = clean_text(request.form.get("name"), 200) or file_name[:-4] or file_name
    tags = clean_tags(request.form.get("tags", "[]"))

    stored_name = f"{uuid.uuid4().hex}.stl"
    path = FILES_DIR / stored_name
    upload.save(path)
    size = path.stat().st_size
    if size == 0:
        path.unlink(missing_ok=True)
        raise ApiError("Файл пустой")

    now = time.time()
    uid = current_user()["id"]
    con = db()
    cur = con.execute(
        "INSERT INTO models (project_id, name, file_name, stored_name, size, uploaded_by, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (pid, name, file_name, stored_name, size, uid, now, now),
    )
    mid = cur.lastrowid
    thumb = request.files.get("thumbnail")
    if thumb is not None and save_thumbnail(mid, thumb):
        con.execute("UPDATE models SET has_thumb = 1, thumb_ver = 1 WHERE id = ?", (mid,))
    set_tags("model_tags", "model_id", mid, tags)
    touch_project(pid)
    con.commit()
    return jsonify(model_with_tags(mid)), 201


@app.get("/api/models/<int:mid>")
@login_required
def get_model(mid):
    row = get_row("models", mid)
    tags = tags_by_owner("model_tags", "model_id", "WHERE model_id = ?", (mid,)).get(mid, [])
    comments = db().execute("SELECT * FROM comments WHERE model_id = ? ORDER BY created_at", (mid,)).fetchall()
    result = model_dict(row, tags, len(comments))
    result["comments"] = [comment_dict(c) for c in comments]
    return jsonify(result)


@app.patch("/api/models/<int:mid>")
@login_required
def update_model(mid):
    row = get_row("models", mid)
    data = json_body()
    con = db()
    if "name" in data:
        name = clean_text(data.get("name"), 200)
        if not name:
            raise ApiError("Название не может быть пустым")
        con.execute("UPDATE models SET name = ? WHERE id = ?", (name, mid))
    if "description" in data:
        con.execute("UPDATE models SET description = ? WHERE id = ?", (clean_text(data.get("description"), 20000), mid))
    if "tags" in data:
        set_tags("model_tags", "model_id", mid, clean_tags(data.get("tags")))
    con.execute("UPDATE models SET updated_at = ?, updated_by = ? WHERE id = ?", (time.time(), current_user()["id"], mid))
    touch_project(row["project_id"])
    con.commit()
    return jsonify(model_with_tags(mid))


@app.delete("/api/models/<int:mid>")
@login_required
def delete_model(mid):
    row = get_row("models", mid)
    require_owner(row["uploaded_by"])
    con = db()
    con.execute("DELETE FROM models WHERE id = ?", (mid,))
    touch_project(row["project_id"])
    con.commit()
    remove_model_files(mid, row["stored_name"])
    return jsonify(ok=True)


@app.get("/api/models/<int:mid>/file")
@login_required
def download_model(mid):
    row = get_row("models", mid)
    inline = request.args.get("inline") == "1"
    return send_from_directory(
        FILES_DIR, row["stored_name"], mimetype="model/stl",
        as_attachment=not inline, download_name=row["file_name"],
    )


@app.get("/api/models/<int:mid>/thumb")
@login_required
def get_thumb(mid):
    get_row("models", mid)
    return send_from_directory(THUMBS_DIR, f"{mid}.png", mimetype="image/png", max_age=60 * 60 * 24 * 365)


@app.put("/api/models/<int:mid>/thumb")
@login_required
def put_thumb(mid):
    row = get_row("models", mid)
    thumb = request.files.get("thumbnail")
    if thumb is None or not save_thumbnail(mid, thumb):
        raise ApiError("Некорректное изображение")
    con = db()
    con.execute("UPDATE models SET has_thumb = 1, thumb_ver = thumb_ver + 1 WHERE id = ?", (mid,))
    touch_project(row["project_id"])
    con.commit()
    return jsonify(model_with_tags(mid))


# ---------- comments ----------

@app.post("/api/models/<int:mid>/comments")
@login_required
def add_comment(mid):
    get_row("models", mid)
    text = clean_text(json_body().get("text"), 5000)
    if not text:
        raise ApiError("Комментарий пустой")
    con = db()
    cur = con.execute("INSERT INTO comments (model_id, user_id, text, created_at) VALUES (?, ?, ?, ?)",
                      (mid, current_user()["id"], text, time.time()))
    con.commit()
    return jsonify(comment_dict(get_row("comments", cur.lastrowid))), 201


@app.delete("/api/comments/<int:cid>")
@login_required
def delete_comment(cid):
    row = get_row("comments", cid)
    require_owner(row["user_id"])
    con = db()
    con.execute("DELETE FROM comments WHERE id = ?", (cid,))
    con.commit()
    return jsonify(ok=True)


# ---------- CLI ----------

def cli(args):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    con = sqlite3.connect(DB_PATH)
    try:
        cmd = args[0]
        if cmd == "users":
            for r in con.execute("SELECT login, name, is_admin FROM users ORDER BY id"):
                print(f"{r[0]:<20} {r[1]:<30} {'админ' if r[2] else ''}")
        elif cmd == "reset-password" and len(args) == 3:
            n = con.execute("UPDATE users SET password_hash = ? WHERE login = ?",
                            (generate_password_hash(args[2]), args[1])).rowcount
            print("Пароль изменён" if n else "Пользователь не найден")
        elif cmd == "make-admin" and len(args) == 2:
            n = con.execute("UPDATE users SET is_admin = 1 WHERE login = ?", (args[1],)).rowcount
            print("Готово" if n else "Пользователь не найден")
        else:
            print(__doc__)
            return 1
        con.commit()
        return 0
    finally:
        con.close()


init_storage()

if __name__ == "__main__":
    if len(sys.argv) > 1:
        sys.exit(cli(sys.argv[1:]))

    from waitress import serve

    print(f"STL-хранилище запущено: http://localhost:{PORT}  (данные: {DATA_DIR})")
    serve(app, host=HOST, port=PORT, threads=THREADS,
          max_request_body_size=MAX_UPLOAD_MB * 1024 * 1024, channel_timeout=300)
