import { Viewer, parseSTL, geometryInfo, thumbnailFromBuffer, thumbnailFromGeometry } from './viewer.js';

const $app = document.getElementById('app');
const $userSlot = document.getElementById('user-slot');

const state = {
  me: null,
  allowRegistration: true,
  projects: [],
  home: { q: '', tags: new Set(), author: '', sort: 'recent' },
  project: null,
  proj: { q: '', tags: new Set(), author: '', sort: 'recent' },
};

// ============================================================ utils

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  cube: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  grid: '<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  wire: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 20 16.5M20 7.5 4 16.5M12 3v18"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  zip: '<path d="M6 3h9l4 4v14H6z"/><path d="M11 3v2M11 7v2M11 11v2M10 15h2v3h-2z"/>',
};

function icon(name) {
  const span = document.createElement('span');
  span.className = 'ic';
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (k.includes('-') || k === 'list' || !(k in el)) el.setAttribute(k, v === true ? '' : v);
    else el[k] = v;
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** replaceChildren, пропускающий null/false и вложенные массивы. */
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

function plural(n, forms) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? forms[0] : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? forms[1] : forms[2];
  return `${n} ${w}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`;
}

function formatDate(ts, withTime = true) {
  const d = new Date(ts * 1000);
  const opts = { day: 'numeric', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('ru-RU', opts);
}

function formatNum(n) {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

const AVATAR_COLORS = ['#4c6ef5', '#7950f2', '#be4bdb', '#e64980', '#f76707', '#f59f00', '#37b24d', '#0ca678', '#1098ad', '#1c7ed6'];

function avatar(user, size = '') {
  const name = user?.name || '?';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const color = user ? AVATAR_COLORS[user.id % AVATAR_COLORS.length] : '#868e96';
  return h('span', { class: `avatar ${size}`, style: `background:${color}`, title: name }, initials);
}

function userChip(user, size = 'sm') {
  return h('span', { class: 'user-chip' }, avatar(user, size), h('span', { class: 'user-name' }, user?.name || 'Неизвестно'));
}

function canDelete(ownerRef) {
  return state.me && (state.me.is_admin || (ownerRef && ownerRef.id === state.me.id));
}

function matchQuery(q, ...fields) {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  return fields.flat().some((f) => f && String(f).toLowerCase().includes(needle));
}

function sortItems(items, sort) {
  const arr = [...items];
  if (sort === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
  else if (sort === 'old') arr.sort((a, b) => a.created_at - b.created_at);
  else if (sort === 'new') arr.sort((a, b) => b.created_at - a.created_at);
  else arr.sort((a, b) => b.updated_at - a.updated_at);
  return arr;
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* недоступно — не страшно */ }
  return null;
}

// ============================================================ api

class AuthError extends Error {}

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(url, opt);
  } catch {
    throw new Error('Сервер недоступен');
  }
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (r.status === 401 && !url.startsWith('/api/auth/')) {
    state.me = null;
    renderUserSlot();
    showAuth();
    throw new AuthError('Требуется вход');
  }
  if (!r.ok) throw new Error(data?.error || `Ошибка ${r.status}`);
  return data;
}

function xhr(method, url, { body, responseType = 'json', onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    x.responseType = responseType;
    const target = method === 'GET' ? x : x.upload;
    target.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve(x.response);
      const msg = responseType === 'json' ? x.response?.error : null;
      reject(new Error(msg || `Ошибка ${x.status}`));
    };
    x.onerror = () => reject(new Error('Сетевая ошибка'));
    x.send(body);
  });
}

function reportError(e) {
  if (!(e instanceof AuthError)) toast(e.message || String(e), 'error');
}

// ============================================================ toasts & modals

function toast(message, type = '') {
  const el = h('div', { class: `toast ${type}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 5000 : 2600);
}

const modalStack = [];

function openModal({ content, className = '', onClose }) {
  const box = h('div', { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true' }, content);
  const backdrop = h('div', { class: 'modal-backdrop' }, box);
  let closed = false;
  const entry = { close };
  function close(...args) {
    if (closed) return;
    closed = true;
    backdrop.remove();
    modalStack.splice(modalStack.indexOf(entry), 1);
    if (!modalStack.length) document.body.classList.remove('no-scroll');
    onClose?.(...args);
  }
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  document.body.classList.add('no-scroll');
  modalStack.push(entry);
  requestAnimationFrame(() => backdrop.classList.add('open'));
  return { close, box };
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalStack.length && !document.fullscreenElement) modalStack.at(-1).close();
});

function confirmDialog({ title, text, okText = 'Удалить', danger = true }) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { result = true; m.close(); } }, okText);
    const m = openModal({
      onClose: () => resolve(result),
      content: h('div', { class: 'form' },
        h('h2', { class: 'modal-title' }, title),
        text && h('p', { class: 'modal-text' }, text),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: () => m.close() }, 'Отмена'),
          ok)),
    });
    setTimeout(() => ok.focus(), 30);
  });
}

// ============================================================ tag editor

function normTag(t) {
  return t.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 40);
}

function tagEditor(initial, suggestions, onChange) {
  let tags = [...initial];
  const listId = `tags-${Math.random().toString(36).slice(2)}`;
  const input = h('input', { class: 'tag-input', placeholder: tags.length ? '' : 'Добавить тег…', list: listId, maxLength: 40 });
  const datalist = h('datalist', { id: listId });
  const wrap = h('div', { class: 'tag-editor', onclick: () => input.focus() });

  function render() {
    fill(datalist, ...suggestions.filter((s) => !tags.includes(s)).map((s) => h('option', { value: s })));
    input.placeholder = tags.length ? '' : 'Добавить тег…';
    fill(wrap,
      ...tags.map((t) => h('span', { class: 'tag' }, t,
        h('button', { class: 'tag-x', type: 'button', title: 'Убрать тег', onclick: (e) => { e.stopPropagation(); remove(t); } }, icon('x')))),
      input, datalist);
  }
  function add(raw, refocus = true) {
    let changed = false;
    for (const part of raw.split(',')) {
      const t = normTag(part);
      if (t && !tags.includes(t)) { tags.push(t); changed = true; }
    }
    input.value = '';
    if (!changed) return;
    render();
    if (refocus) input.focus();
    onChange?.([...tags]);
  }
  function remove(t) {
    tags = tags.filter((x) => x !== t);
    render();
    onChange?.([...tags]);
  }
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' && input.value.trim()) || e.key === ',') { e.preventDefault(); add(input.value); }
    else if (e.key === 'Backspace' && !input.value && tags.length) remove(tags.at(-1));
  });
  input.addEventListener('input', (e) => {
    // выбор из подсказок datalist
    if (!e.inputType || e.inputType === 'insertReplacementText') add(input.value);
  });
  input.addEventListener('blur', () => { if (input.value.trim()) add(input.value, false); });
  render();
  return {
    el: wrap,
    get() { if (input.value.trim()) add(input.value, false); return [...tags]; },
  };
}

// ============================================================ shared UI pieces

function searchBox(value, placeholder, onInput) {
  return h('label', { class: 'search' }, icon('search'),
    h('input', { class: 'input', type: 'search', value, placeholder, oninput: (e) => onInput(e.target.value) }));
}

function sortSelect(value, onChange) {
  return h('select', { class: 'select', title: 'Сортировка', onchange: (e) => onChange(e.target.value) },
    [['recent', 'Недавно изменённые'], ['new', 'Сначала новые'], ['old', 'Сначала старые'], ['name', 'По названию']]
      .map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

function authorSelect(users, value, onChange) {
  return h('select', { class: 'select', title: 'Автор', onchange: (e) => onChange(e.target.value) },
    h('option', { value: '' }, 'Все авторы'),
    state.me && h('option', { value: String(state.me.id), selected: value === String(state.me.id) }, 'Только мои'),
    users.filter((u) => u.id !== state.me?.id).map((u) => h('option', { value: String(u.id), selected: value === String(u.id) }, u.name)));
}

function uniqueUsers(refs) {
  const map = new Map();
  for (const u of refs) if (u) map.set(u.id, u);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function tagFilterChips(items, selected, onToggle) {
  const counts = new Map();
  for (const it of items) for (const t of it.tags) counts.set(t, (counts.get(t) || 0) + 1);
  for (const t of [...selected]) if (!counts.has(t)) selected.delete(t);
  if (!counts.size) return [];
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  return [
    ...sorted.map(([t, n]) => h('button', {
      class: `chip ${selected.has(t) ? 'active' : ''}`, type: 'button', onclick: () => onToggle(t),
    }, t, h('span', { class: 'count' }, n))),
    selected.size ? h('button', { class: 'chip-reset', type: 'button', onclick: () => { selected.clear(); onToggle(null); } }, 'Сбросить') : null,
  ];
}

function cardTags(tags, selected, onToggle) {
  if (!tags.length) return null;
  return h('div', { class: 'tags' }, tags.map((t) => h('button', {
    class: `tag ${selected.has(t) ? 'active' : ''}`, type: 'button', title: 'Фильтровать по тегу',
    onclick: (e) => { e.stopPropagation(); onToggle(t); },
  }, t)));
}

function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(iconName)), h('h3', {}, title), text && h('p', {}, text), action);
}

/** Закреплённая первая плитка сетки со знаком «+». */
function addTile(label, hint, onClick) {
  return h('button', { class: 'card add-tile', type: 'button', onclick: onClick },
    h('div', { class: 'cover' },
      h('span', { class: 'add-plus' }, icon('plus')),
      h('span', { class: 'add-label' }, label),
      hint && h('span', { class: 'add-hint' }, hint)));
}

function noResults(onReset) {
  return h('div', { class: 'no-results' }, 'Ничего не найдено.',
    h('button', { class: 'link-btn', type: 'button', onclick: onReset }, 'Сбросить фильтры'));
}

function brandMark() {
  const el = h('span', { class: 'brand-mark' });
  el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/></svg>';
  return el;
}

function loadingState() {
  return h('div', { class: 'center-load' }, h('div', { class: 'spinner' }));
}

function downloadUrl(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

// ============================================================ auth

async function boot() {
  try {
    const r = await api('GET', '/api/auth/me');
    state.me = r.user;
    state.allowRegistration = r.allow_registration;
  } catch (e) {
    fill($app, emptyState('cube', 'Сервер недоступен', e.message));
    return;
  }
  renderUserSlot();
  if (state.me) route();
  else showAuth();
}

function showAuth(mode = 'login') {
  closeModelModal(true);
  while (modalStack.length) modalStack.at(-1).close();
  document.title = 'Вход — STL Хранилище';
  const isLogin = mode === 'login';
  const login = h('input', { class: 'input', autocomplete: 'username', required: true, value: storage('stl-last-login') || '' });
  const name = h('input', { class: 'input', autocomplete: 'name', placeholder: 'Например: Иван Петров', maxLength: 60 });
  const password = h('input', { class: 'input', type: 'password', autocomplete: isLogin ? 'current-password' : 'new-password', required: true });
  const err = h('div', { class: 'form-error' });
  const submit = h('button', { class: 'btn btn-primary full', type: 'submit' }, isLogin ? 'Войти' : 'Создать профиль');

  const form = h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const body = { login: login.value.trim(), password: password.value };
        if (!isLogin) body.name = name.value.trim();
        const r = await api('POST', isLogin ? '/api/auth/login' : '/api/auth/register', body);
        state.me = r.user;
        storage('stl-last-login', state.me.login);
        renderUserSlot();
        if (!location.hash || location.hash === '#') location.hash = '#/';
        route();
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    },
  },
  h('label', { class: 'field' }, h('span', { class: 'label' }, 'Логин'), login),
  !isLogin && h('label', { class: 'field' }, h('span', { class: 'label' }, 'Имя'), name,
    h('span', { class: 'hint' }, 'Так вас будут видеть другие')),
  h('label', { class: 'field' }, h('span', { class: 'label' }, 'Пароль'), password),
  err, submit);

  fill($app, h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' },
    brandMark(),
    h('h1', {}, isLogin ? 'Вход' : 'Регистрация'),
    h('p', { class: 'muted' }, isLogin ? 'Войдите, чтобы открыть хранилище моделей' : 'Создайте профиль, чтобы загружать модели и комментировать'),
    form,
    (state.allowRegistration || !isLogin) && h('div', { class: 'auth-switch' },
      isLogin ? 'Нет профиля? ' : 'Уже есть профиль? ',
      h('button', { class: 'link-btn', type: 'button', onclick: () => showAuth(isLogin ? 'register' : 'login') },
        isLogin ? 'Зарегистрироваться' : 'Войти')))));
  setTimeout(() => (login.value ? password : login).focus(), 30);
}

function renderUserSlot() {
  if (!state.me) return fill($userSlot);
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; document.removeEventListener('mousedown', outside); };
  const outside = (e) => { if (!wrap.contains(e.target)) closeMenu(); };
  const wrap = h('div', { class: 'user-menu' },
    h('button', {
      class: 'user-btn', type: 'button',
      onclick: () => {
        if (menu) return closeMenu();
        menu = h('div', { class: 'menu' },
          h('div', { class: 'menu-head' },
            h('div', {}, h('b', {}, state.me.name), ' ', state.me.is_admin && h('span', { class: 'badge' }, 'админ')),
            h('div', { class: 'muted' }, `@${state.me.login}`)),
          h('button', { class: 'menu-item', type: 'button', onclick: () => { closeMenu(); profileDialog(); } }, icon('user'), 'Профиль и пароль'),
          h('button', { class: 'menu-item', type: 'button', onclick: async () => { closeMenu(); await logout(); } }, icon('logout'), 'Выйти'));
        wrap.append(menu);
        document.addEventListener('mousedown', outside);
      },
    }, avatar(state.me), h('span', {}, state.me.name)));
  fill($userSlot, wrap);
}

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch { /* всё равно выходим */ }
  state.me = null;
  renderUserSlot();
  showAuth();
}

function profileDialog() {
  const name = h('input', { class: 'input', value: state.me.name, maxLength: 60 });
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'form-error' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Сохранить');
  const m = openModal({
    content: h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const body = { name: name.value.trim() };
        if (next.value) Object.assign(body, { password: cur.value, new_password: next.value });
        submit.disabled = true;
        try {
          const r = await api('PATCH', '/api/auth/me', body);
          state.me = r.user;
          renderUserSlot();
          m.close();
          toast('Профиль сохранён');
          route(true);
        } catch (ex) {
          err.textContent = ex.message;
          submit.disabled = false;
        }
      },
    },
    h('h2', { class: 'modal-title' }, 'Профиль'),
    h('div', { class: 'user-chip' }, avatar(state.me, 'lg'), h('span', { class: 'muted' }, `Логин: ${state.me.login}`)),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Имя'), name),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Текущий пароль'), cur,
      h('span', { class: 'hint' }, 'Нужен только для смены пароля')),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Новый пароль'), next),
    err,
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена'), submit)),
  });
}

// ============================================================ router

let modelModal = null; // { mid, close }

window.addEventListener('hashchange', () => route());

async function route(force = false) {
  if (!state.me) return showAuth();
  const hash = location.hash.slice(1) || '/';
  const m = hash.match(/^\/p\/(\d+)(?:\/m\/(\d+))?$/);
  if (m) {
    const pid = Number(m[1]);
    const mid = m[2] ? Number(m[2]) : null;
    const onPage = state.project?.id === pid && $app.querySelector('.project-page');
    if (force || !onPage) await showProject(pid);
    syncModelModal(mid);
  } else {
    closeModelModal(true);
    await showHome();
  }
}

// ============================================================ home: projects

async function showHome() {
  state.project = null;
  document.title = 'STL Хранилище';
  if (!$app.querySelector('.home-page')) fill($app, loadingState());
  try {
    state.projects = await api('GET', '/api/projects');
  } catch (e) {
    if (!(e instanceof AuthError)) fill($app, emptyState('cube', 'Не удалось загрузить проекты', e.message));
    return;
  }
  const s = state.home;
  fill($app, h('div', { class: 'page home-page' },
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', { class: 'page-title' }, 'Проекты'),
        h('div', { class: 'page-sub', id: 'home-sub' }))),
    state.projects.length > 0 && h('div', { class: 'toolbar' },
      searchBox(s.q, 'Поиск по названию или тегу', (v) => { s.q = v; renderHomeList(); }),
      authorSelect(uniqueUsers(state.projects.map((p) => p.created_by)), s.author, (v) => { s.author = v; renderHomeList(); }),
      sortSelect(s.sort, (v) => { s.sort = v; renderHomeList(); })),
    h('div', { class: 'chips', id: 'home-chips' }),
    h('div', { id: 'home-results' })));
  renderHomeList();
}

function renderHomeList() {
  const s = state.home;
  const toggle = (t) => { if (t) s.tags.has(t) ? s.tags.delete(t) : s.tags.add(t); renderHomeList(); };
  fill(document.getElementById('home-chips'), ...tagFilterChips(state.projects, s.tags, toggle));
  document.getElementById('home-sub').textContent = plural(state.projects.length, ['проект', 'проекта', 'проектов']);

  const list = sortItems(state.projects.filter((p) =>
    matchQuery(s.q, p.name, p.tags)
    && [...s.tags].every((t) => p.tags.includes(t))
    && (!s.author || String(p.created_by?.id) === s.author)), s.sort);

  const results = document.getElementById('home-results');
  const filtered = s.q || s.tags.size || s.author;
  fill(results,
    filtered && !list.length && noResults(() => { s.q = ''; s.tags.clear(); s.author = ''; showHome(); }),
    h('div', { class: 'grid' },
      addTile('Новый проект', null, () => projectDialog()),
      list.map((p) => projectCard(p, toggle))));
}

function projectCover(covers) {
  if (!covers.length) return h('div', { class: 'cover' }, h('div', { class: 'cover-empty' }, icon('folder')));
  if (covers.length === 1) return h('div', { class: 'cover' }, h('img', { src: covers[0], alt: '', loading: 'lazy' }));
  return h('div', { class: 'cover' }, h('div', { class: `cover-grid n${covers.length}` },
    covers.map((src) => h('img', { src, alt: '', loading: 'lazy' }))));
}

function projectCard(p, toggleTag) {
  const open = () => { location.hash = `#/p/${p.id}`; };
  return h('div', {
    class: 'card', tabIndex: 0, role: 'link',
    onclick: open, onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); },
  },
  projectCover(p.covers),
  h('div', { class: 'card-body' },
    h('div', { class: 'card-title', title: p.name }, p.name),
    h('div', { class: 'card-meta' },
      plural(p.model_count, ['модель', 'модели', 'моделей']),
      p.created_by && [h('span', { class: 'dot' }, '·'), userChip(p.created_by)]),
    cardTags(p.tags, state.home.tags, toggleTag)),
  canDelete(p.created_by) && h('div', { class: 'card-actions' },
    h('button', { class: 'icon-btn danger', type: 'button', title: 'Удалить проект', onclick: (e) => { e.stopPropagation(); deleteProject(p); } }, icon('trash'))));
}

function projectDialog(project = null) {
  const allTags = [...new Set(state.projects.flatMap((p) => p.tags))].sort();
  const name = h('input', { class: 'input', value: project?.name || '', placeholder: 'Например: Корпус для датчика', maxLength: 120 });
  const tags = tagEditor(project?.tags || [], allTags);
  const err = h('div', { class: 'form-error' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, project ? 'Сохранить' : 'Создать проект');
  const m = openModal({
    content: h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        const n = name.value.trim();
        if (!n) { err.textContent = 'Введите название'; name.focus(); return; }
        submit.disabled = true;
        try {
          const body = { name: n, tags: tags.get() };
          if (project) {
            await api('PATCH', `/api/projects/${project.id}`, body);
            m.close();
            route(true);
          } else {
            const created = await api('POST', '/api/projects', body);
            m.close();
            location.hash = `#/p/${created.id}`;
          }
        } catch (ex) {
          err.textContent = ex.message;
          submit.disabled = false;
        }
      },
    },
    h('h2', { class: 'modal-title' }, project ? 'Редактировать проект' : 'Новый проект'),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Название'), name),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Теги'), tags.el,
      h('span', { class: 'hint' }, 'Enter или запятая — добавить тег. По тегам работают фильтры.')),
    err,
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена'), submit)),
  });
  setTimeout(() => name.focus(), 30);
}

async function deleteProject(p) {
  const ok = await confirmDialog({
    title: `Удалить проект «${p.name}»?`,
    text: p.model_count ? `Вместе с ним будут удалены ${plural(p.model_count, ['модель', 'модели', 'моделей'])} и все комментарии. Это действие нельзя отменить.` : 'Это действие нельзя отменить.',
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/projects/${p.id}`);
    toast('Проект удалён');
    if (state.project?.id === p.id) location.hash = '#/';
    else showHome();
  } catch (e) { reportError(e); }
}

// ============================================================ project page: models

let fileInput = null;

async function showProject(pid) {
  if (state.project?.id !== pid) {
    state.proj = { q: '', tags: new Set(), author: '', sort: 'recent' };
    fill($app, loadingState());
  }
  let p;
  try {
    p = await api('GET', `/api/projects/${pid}`);
  } catch (e) {
    if (!(e instanceof AuthError)) {
      fill($app, h('div', { class: 'page' },
        h('a', { class: 'back-link', href: '#/' }, icon('back'), 'Все проекты'),
        emptyState('folder', 'Проект не найден', e.message)));
    }
    return;
  }
  state.project = p;
  document.title = `${p.name} — STL Хранилище`;
  const s = state.proj;
  fileInput = h('input', { type: 'file', accept: '.stl', multiple: true, hidden: true, onchange: (e) => { uploadFiles(e.target.files); e.target.value = ''; } });
  fill($app, h('div', { class: 'page project-page' },
    h('a', { class: 'back-link', href: '#/' }, icon('back'), 'Все проекты'),
    h('div', { class: 'page-head', id: 'proj-head' }),
    h('div', { class: 'toolbar', id: 'proj-toolbar' },
      searchBox(s.q, 'Поиск моделей', (v) => { s.q = v; renderProjectList(); }),
      h('span', { id: 'proj-author' }),
      sortSelect(s.sort, (v) => { s.sort = v; renderProjectList(); })),
    h('div', { class: 'chips', id: 'proj-chips' }),
    h('div', { id: 'proj-results' }),
    fileInput));
  renderProjectHead();
  renderProjectList();
}

function renderProjectHead() {
  const p = state.project;
  const head = document.getElementById('proj-head');
  if (!head) return;
  fill(head,
    h('div', { style: 'min-width:0' },
      h('h1', { class: 'page-title' }, p.name),
      h('div', { class: 'page-sub' },
        plural(p.models.length, ['модель', 'модели', 'моделей']),
        p.created_by && [h('span', {}, '· создал'), userChip(p.created_by)],
        h('span', {}, `· ${formatDate(p.created_at, false)}`)),
      p.tags.length ? h('div', { class: 'tags' }, p.tags.map((t) => h('span', { class: 'tag static' }, t))) : null),
    h('div', { class: 'head-actions' },
      h('button', { class: 'btn', onclick: () => projectDialog(p) }, icon('edit'), 'Изменить'),
      p.models.length ? h('button', { class: 'icon-btn bordered', title: 'Скачать все модели (ZIP)', onclick: () => downloadUrl(`/api/projects/${p.id}/zip`) }, icon('zip')) : null,
      canDelete(p.created_by) && h('button', { class: 'icon-btn bordered danger', title: 'Удалить проект', onclick: () => deleteProject({ ...p, model_count: p.models.length }) }, icon('trash'))));
}

function renderProjectList() {
  const p = state.project;
  const s = state.proj;
  if (!document.getElementById('proj-results')) return;
  const toggle = (t) => { if (t) s.tags.has(t) ? s.tags.delete(t) : s.tags.add(t); renderProjectList(); };
  document.getElementById('proj-toolbar').hidden = !p.models.length;
  fill(document.getElementById('proj-chips'), ...tagFilterChips(p.models, s.tags, toggle));
  const authors = uniqueUsers(p.models.map((m) => m.uploaded_by));
  if (s.author && !authors.some((u) => String(u.id) === s.author)) s.author = '';
  fill(document.getElementById('proj-author'), authors.length > 1 || s.author
    ? authorSelect(authors, s.author, (v) => { s.author = v; renderProjectList(); }) : '');

  const list = sortItems(p.models.filter((m) =>
    matchQuery(s.q, m.name, m.file_name, m.tags, m.description)
    && [...s.tags].every((t) => m.tags.includes(t))
    && (!s.author || String(m.uploaded_by?.id) === s.author)), s.sort);
  const pending = uploads.filter((u) => u.pid === p.id).map((u) => u.el);

  const results = document.getElementById('proj-results');
  const filtered = s.q || s.tags.size || s.author;
  fill(results,
    filtered && !list.length && noResults(() => { s.q = ''; s.tags.clear(); s.author = ''; showProject(p.id); }),
    h('div', { class: 'grid' },
      addTile('Загрузить STL', 'или перетащите файлы в окно', () => fileInput.click()),
      pending,
      list.map((m) => modelCard(m, toggle))));
}

function modelCard(m, toggleTag) {
  const open = () => { location.hash = `#/p/${m.project_id}/m/${m.id}`; };
  return h('div', {
    class: 'card', tabIndex: 0, role: 'button',
    onclick: open, onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); },
  },
  h('div', { class: 'cover' }, m.thumb ? h('img', { src: m.thumb, alt: '', loading: 'lazy' }) : h('div', { class: 'cover-empty' }, icon('cube'))),
  h('div', { class: 'card-body' },
    h('div', { class: 'card-title', title: m.name }, m.name),
    h('div', { class: 'card-meta' },
      userChip(m.uploaded_by),
      h('span', { class: 'dot' }, '·'), formatSize(m.size),
      m.comment_count ? [h('span', { class: 'dot' }, '·'), icon('chat'), m.comment_count] : null),
    cardTags(m.tags, state.proj.tags, toggleTag)),
  h('div', { class: 'card-actions' },
    h('button', { class: 'icon-btn', type: 'button', title: 'Скачать STL', onclick: (e) => { e.stopPropagation(); downloadUrl(`/api/models/${m.id}/file`); } }, icon('download')),
    canDelete(m.uploaded_by) && h('button', { class: 'icon-btn danger', type: 'button', title: 'Удалить модель', onclick: (e) => { e.stopPropagation(); deleteModel(m); } }, icon('trash'))));
}

async function deleteModel(m, afterDelete) {
  const ok = await confirmDialog({ title: `Удалить модель «${m.name}»?`, text: 'Файл, миниатюра и комментарии будут удалены без возможности восстановления.' });
  if (!ok) return;
  try {
    await api('DELETE', `/api/models/${m.id}`);
    toast('Модель удалена');
    if (state.project?.id === m.project_id) {
      state.project.models = state.project.models.filter((x) => x.id !== m.id);
      renderProjectHead();
      renderProjectList();
    }
    afterDelete?.();
  } catch (e) { reportError(e); }
}

async function refreshProject() {
  const p = state.project;
  if (!p || !$app.querySelector('.project-page')) return;
  try {
    const fresh = await api('GET', `/api/projects/${p.id}`);
    if (state.project?.id !== fresh.id) return;
    state.project = fresh;
    renderProjectHead();
    renderProjectList();
  } catch (e) { reportError(e); }
}

// ============================================================ upload

const uploads = [];
let uploading = false;

function uploadFiles(fileList) {
  if (!state.project) return;
  const files = [...fileList];
  const stl = files.filter((f) => /\.stl$/i.test(f.name));
  if (stl.length < files.length) toast(`Пропущено файлов не в формате STL: ${files.length - stl.length}`, 'error');
  for (const file of stl) {
    const u = { pid: state.project.id, file, name: file.name.replace(/\.stl$/i, '') };
    u.stage = h('span', {}, 'В очереди');
    u.bar = h('div');
    u.el = h('div', { class: 'card uploading' },
      h('div', { class: 'cover' }, h('div', { class: 'upload-state' }, h('div', { class: 'spinner' }), u.stage, h('div', { class: 'progress' }, u.bar))),
      h('div', { class: 'card-body' },
        h('div', { class: 'card-title', title: u.name }, u.name),
        h('div', { class: 'card-meta' }, formatSize(file.size))));
    uploads.push(u);
  }
  renderProjectList();
  processQueue();
}

async function processQueue() {
  if (uploading) return;
  uploading = true;
  let done = 0;
  while (uploads.length) {
    const u = uploads[0];
    u.stage.textContent = 'Создание миниатюры…';
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    let thumb = null;
    try {
      thumb = await thumbnailFromBuffer(await u.file.arrayBuffer());
    } catch (e) {
      console.warn('Миниатюра не создана:', u.file.name, e);
    }
    u.stage.textContent = 'Загрузка…';
    const fd = new FormData();
    fd.append('file', u.file);
    fd.append('name', u.name);
    if (thumb) fd.append('thumbnail', thumb, 'thumb.png');
    try {
      const model = await xhr('POST', `/api/projects/${u.pid}/models`, {
        body: fd,
        onProgress: (p) => { u.bar.style.width = `${Math.round(p * 100)}%`; u.stage.textContent = `Загрузка… ${Math.round(p * 100)}%`; },
      });
      done++;
      if (state.project?.id === u.pid) state.project.models.unshift(model);
    } catch (e) {
      toast(`${u.file.name}: ${e.message}`, 'error');
    }
    uploads.shift();
    if (state.project?.id === u.pid) { renderProjectHead(); renderProjectList(); }
  }
  uploading = false;
  if (done) toast(done === 1 ? 'Модель загружена' : `Загружено моделей: ${done}`);
}

// drag & drop файлов на страницу проекта
const dropOverlay = h('div', { class: 'drop-overlay' },
  h('div', { class: 'drop-box' }, icon('upload'), 'Отпустите, чтобы загрузить STL'));
document.body.append(dropOverlay);
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
const canDrop = () => state.project && $app.querySelector('.project-page') && !modalStack.length;
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (!canDrop()) return;
  dragDepth++;
  dropOverlay.classList.add('show');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = canDrop() ? 'copy' : 'none';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.remove('show'); }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('show');
  if (canDrop()) uploadFiles(e.dataTransfer.files);
});

// ============================================================ model modal

function syncModelModal(mid) {
  if (mid == null) return closeModelModal(true);
  if (modelModal?.mid === mid) return;
  closeModelModal(true);
  openModelModal(mid);
}

function closeModelModal(fromRoute) {
  modelModal?.close(fromRoute);
}

function openModelModal(mid) {
  const pid = state.project?.id;
  const ctx = { mid, closed: false, dirty: false, viewer: null, model: null };
  const viewerHost = h('div', { class: 'viewer-canvas' });
  const loadingText = h('div', {}, 'Загрузка модели…');
  const loading = h('div', { class: 'viewer-loading' }, h('div', { class: 'spinner' }), loadingText);
  const dims = h('div', { class: 'viewer-dims', hidden: true });
  const toolbar = h('div', { class: 'viewer-toolbar', hidden: true });
  const viewerWrap = h('div', { class: 'viewer-wrap' }, viewerHost, loading, toolbar, dims,
    h('div', { class: 'viewer-hint' }, 'ЛКМ — вращение · ПКМ — сдвиг · колесо — масштаб'));
  const side = h('div', { class: 'model-side' }, loadingState());

  const modal = openModal({
    className: 'model-modal',
    content: [viewerWrap, side],
    onClose: (fromRoute) => {
      ctx.closed = true;
      ctx.viewer?.dispose();
      if (modelModal === entry) modelModal = null;
      if (fromRoute !== true && pid) location.hash = `#/p/${pid}`;
      if (ctx.dirty) refreshProject();
    },
  });
  const entry = { mid, close: modal.close };
  modelModal = entry;

  (async () => {
    try {
      ctx.model = await api('GET', `/api/models/${mid}`);
    } catch (e) {
      reportError(e);
      modal.close();
      return;
    }
    if (ctx.closed) return;
    renderModelSide(ctx, side, modal);
    ctx.viewer = new Viewer(viewerHost);
    try {
      const buf = await xhr('GET', `/api/models/${mid}/file?inline=1`, {
        responseType: 'arraybuffer',
        onProgress: (p) => { loadingText.textContent = `Загрузка модели… ${Math.round(p * 100)}%`; },
      });
      if (ctx.closed) return;
      loadingText.textContent = 'Обработка…';
      await new Promise((r) => setTimeout(r));
      const geometry = parseSTL(buf);
      if (ctx.closed) { geometry.dispose(); return; }
      ctx.viewer.setGeometry(geometry);
      loading.remove();
      const info = geometryInfo(geometry);
      dims.hidden = false;
      dims.textContent = `${formatNum(info.x)} × ${formatNum(info.y)} × ${formatNum(info.z)} мм`;
      ctx.setGeometryInfo?.(info);
      renderViewerToolbar(ctx, toolbar, viewerWrap);
      toolbar.hidden = false;
      if (!ctx.model.thumb) {
        // старые/битые записи без миниатюры — создаём её из загруженной модели
        const blob = await thumbnailFromGeometry(geometry);
        await saveThumb(ctx, blob, true);
      }
    } catch (e) {
      if (e instanceof AuthError) return;
      fill(loading, icon('cube'), h('div', {}, `Не удалось открыть модель: ${e.message}`));
    }
  })();
}

async function saveThumb(ctx, blob, silent = false) {
  const fd = new FormData();
  fd.append('thumbnail', blob, 'thumb.png');
  try {
    const upd = await xhr('PUT', `/api/models/${ctx.mid}/thumb`, { body: fd });
    ctx.model.thumb = upd.thumb;
    ctx.dirty = true;
    if (!silent) toast('Миниатюра обновлена');
  } catch (e) {
    if (!silent) reportError(e);
  }
}

function renderViewerToolbar(ctx, toolbar, viewerWrap) {
  const v = ctx.viewer;
  const views = [['iso', '3D'], ['front', 'Спереди'], ['top', 'Сверху'], ['side', 'Сбоку']];
  const viewBtns = views.map(([key, label]) => h('button', {
    class: `vt-btn ${key === 'iso' ? 'active' : ''}`, type: 'button', title: `Вид: ${label.toLowerCase()}`,
    onclick: (e) => { v.setView(key); viewBtns.forEach((b) => b.classList.toggle('active', b === e.currentTarget)); },
  }, label));
  let wire = false;
  let grid = true;
  const wireBtn = h('button', { class: 'vt-btn', type: 'button', title: 'Каркас', onclick: () => { wire = !wire; v.setWireframe(wire); wireBtn.classList.toggle('active', wire); } }, icon('wire'));
  const gridBtn = h('button', { class: 'vt-btn active', type: 'button', title: 'Сетка', onclick: () => { grid = !grid; v.setGrid(grid); gridBtn.classList.toggle('active', grid); } }, icon('grid'));
  fill(toolbar,
    h('div', { class: 'vt-group' }, viewBtns),
    h('div', { class: 'vt-group' }, wireBtn, gridBtn,
      h('button', { class: 'vt-btn', type: 'button', title: 'Сделать миниатюрой текущий ракурс', onclick: async () => saveThumb(ctx, await v.snapshot()) }, icon('camera')),
      h('button', {
        class: 'vt-btn', type: 'button', title: 'Во весь экран',
        onclick: () => (document.fullscreenElement ? document.exitFullscreen() : viewerWrap.requestFullscreen?.()),
      }, icon('expand'))));
}

function renderModelSide(ctx, side, modal) {
  const m = ctx.model;
  const savedFlash = (el) => { el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 1600); };

  async function patch(body, statusEl) {
    try {
      const upd = await api('PATCH', `/api/models/${m.id}`, body);
      Object.assign(m, upd);
      ctx.dirty = true;
      if (statusEl) savedFlash(statusEl);
      renderMeta();
      return true;
    } catch (e) {
      reportError(e);
      return false;
    }
  }

  // название
  const nameInput = h('input', { class: 'title-input', value: m.name, maxLength: 200, title: 'Нажмите, чтобы переименовать' });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
    if (e.key === 'Escape') { e.stopPropagation(); nameInput.value = m.name; nameInput.blur(); }
  });
  nameInput.addEventListener('blur', async () => {
    const v = nameInput.value.trim();
    if (!v) { nameInput.value = m.name; return; }
    if (v !== m.name && !(await patch({ name: v }))) nameInput.value = m.name;
  });

  // теги
  const tagsStatus = h('span', { class: 'status' }, 'Сохранено');
  const tags = tagEditor(m.tags, state.project?.all_model_tags || [], (t) => patch({ tags: t }, tagsStatus));

  // описание
  const descStatus = h('span', { class: 'status' }, 'Сохранено');
  const desc = h('textarea', { class: 'textarea', placeholder: 'Добавьте описание: назначение, материал, настройки печати…', value: m.description, maxLength: 20000 });
  const autosize = () => { desc.style.height = 'auto'; desc.style.height = `${Math.min(desc.scrollHeight + 2, 360)}px`; };
  desc.addEventListener('input', autosize);
  desc.addEventListener('blur', () => { if (desc.value !== m.description) patch({ description: desc.value }, descStatus); });
  requestAnimationFrame(autosize);

  // сведения о файле
  const meta = h('dl', { class: 'info-list' });
  let geomInfo = null;
  ctx.setGeometryInfo = (info) => { geomInfo = info; renderMeta(); };
  function renderMeta() {
    fill(meta,
      h('dt', {}, 'Загрузил'), h('dd', {}, userChip(m.uploaded_by), h('span', { class: 'muted' }, formatDate(m.created_at))),
      m.updated_by && m.updated_at - m.created_at > 5 ? [h('dt', {}, 'Изменил'), h('dd', {}, userChip(m.updated_by), h('span', { class: 'muted' }, formatDate(m.updated_at)))] : null,
      h('dt', {}, 'Файл'), h('dd', {}, m.file_name),
      h('dt', {}, 'Размер'), h('dd', {}, formatSize(m.size)),
      geomInfo && [
        h('dt', {}, 'Габариты'), h('dd', {}, `${formatNum(geomInfo.x)} × ${formatNum(geomInfo.y)} × ${formatNum(geomInfo.z)} мм`),
        h('dt', {}, 'Полигоны'), h('dd', {}, geomInfo.triangles.toLocaleString('ru-RU')),
      ]);
  }
  renderMeta();

  // комментарии
  const commentCount = h('span', { class: 'muted' });
  const commentList = h('div', { class: 'comments' });
  function renderComments() {
    commentCount.textContent = m.comments.length ? String(m.comments.length) : '';
    fill(commentList, ...(m.comments.length
      ? m.comments.map((c) => h('div', { class: 'comment' },
        avatar(c.author, 'lg'),
        h('div', { class: 'comment-main' },
          h('div', { class: 'comment-head' },
            h('b', {}, c.author?.name || 'Неизвестно'),
            h('span', { class: 'muted' }, formatDate(c.created_at)),
            canDelete(c.author) && h('button', {
              class: 'icon-btn sm danger', type: 'button', title: 'Удалить комментарий',
              onclick: async () => {
                if (!(await confirmDialog({ title: 'Удалить комментарий?' }))) return;
                try {
                  await api('DELETE', `/api/comments/${c.id}`);
                  m.comments = m.comments.filter((x) => x.id !== c.id);
                  ctx.dirty = true;
                  renderComments();
                } catch (e) { reportError(e); }
              },
            }, icon('x'))),
          h('div', { class: 'comment-text' }, c.text))))
      : [h('div', { class: 'muted' }, 'Комментариев пока нет')]));
  }
  renderComments();

  const commentText = h('textarea', { class: 'textarea', placeholder: 'Написать комментарий…', maxLength: 5000 });
  const sendBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Отправить');
  const commentForm = h('form', {
    class: 'comment-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const text = commentText.value.trim();
      if (!text) return commentText.focus();
      sendBtn.disabled = true;
      try {
        const c = await api('POST', `/api/models/${m.id}/comments`, { text });
        m.comments.push(c);
        commentText.value = '';
        ctx.dirty = true;
        renderComments();
        commentList.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (ex) { reportError(ex); }
      sendBtn.disabled = false;
    },
  },
  commentText,
  h('div', { class: 'comment-form-row' }, h('span', { class: 'muted small' }, 'Ctrl + Enter — отправить'), sendBtn));
  commentText.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commentForm.requestSubmit(); });

  fill(side,
    h('div', { class: 'side-head' },
      nameInput,
      h('button', { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onclick: () => modal.close() }, icon('x'))),
    h('div', { class: 'side-scroll' },
      h('div', { class: 'side-actions' },
        h('a', { class: 'btn btn-primary', href: `/api/models/${m.id}/file`, download: '' }, icon('download'), 'Скачать STL'),
        canDelete(m.uploaded_by) && h('button', {
          class: 'btn btn-ghost danger', type: 'button',
          onclick: () => deleteModel(m, () => { ctx.dirty = false; modal.close(); }),
        }, icon('trash'), 'Удалить')),
      h('section', {}, h('h3', { class: 'section-title' }, 'Теги', tagsStatus), tags.el),
      h('section', {}, h('h3', { class: 'section-title' }, 'Описание', descStatus), desc),
      h('section', {}, h('h3', { class: 'section-title' }, 'Информация'), meta),
      h('section', {}, h('h3', { class: 'section-title' }, 'Комментарии', commentCount), commentList, commentForm)));
}

boot();
