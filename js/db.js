/* 数据访问层 —— 双适配器（v2.2 接 Supabase）
 * 抽象接口 TodoRepository：getTodos / getTodoById / createTodo / updateTodo / deleteTodo
 * 路由规则（业务层 app.js/paper.js/util.js 零感知）：
 *   - useCloud() = config.js 已填凭据 && 已登录 && 在线 → CloudTodoRepository（Supabase）；
 *   - 否则 → 本机 IndexedDB（离线可用，也是未启用云同步时的默认存储）。
 * 小程序端仍走微信云开发，互不影响。
 */
import { uuid, todayStr } from './util.js';
import { USE_SUPABASE } from './config.js';
import { supaState, getCloudUser, saveCloudUser, CloudTodoRepository, CloudGroupRepository } from './supabase-db.js';

/* 在线走云端、离线回本机（离线期间的改动回到在线后可用「上传本机数据到云端」补传；自动队列在 P3） */
function useCloud() {
  return !!(USE_SUPABASE && supaState().active && (typeof navigator === 'undefined' || navigator.onLine !== false));
}

const DB_NAME = 'yiqi-todo-web';
const DB_VER = 1;
let dbPromise = null;
let MEM = null; // IndexedDB 不可用（隐私模式/个别手机浏览器）时降级内存，保证不白屏

function memStore(store) {
  if (!MEM) MEM = { todos: [], groups: [], meta: [] };
  if (!MEM[store]) MEM[store] = [];
  return MEM[store];
}

function openDB() {
  if (MEM) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('todos')) {
        const s = db.createObjectStore('todos', { keyPath: 'id' });
        s.createIndex('moduleType', 'moduleType');
        s.createIndex('targetDate', 'targetDate');
        s.createIndex('createTime', 'createTime');
      }
      if (!db.objectStoreNames.contains('groups')) {
        const g = db.createObjectStore('groups', { keyPath: 'id' });
        g.createIndex('inviteCode', 'inviteCode', { unique: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    console.error('[Storage] IndexedDB 打开失败，降级为内存存储（本次会话修改不持久化）:', e);
    MEM = { todos: [], groups: [], meta: [] };
    return null;
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then((db) => {
    if (db) {
      return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req && req.result !== undefined ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    }
    // 内存降级路径
    const arr = memStore(store);
    const fakeReq = { result: undefined };
    const keyOf = (v) => (store === 'meta' ? v.key : v.id);
    const fakeStore = {
      getAll: () => { fakeReq.result = arr.map((x) => Object.assign({}, x)); return fakeReq; },
      get: (k) => { const hit = arr.find((x) => keyOf(x) === k); fakeReq.result = hit ? Object.assign({}, hit) : undefined; return fakeReq; },
      put: (v) => { const i = arr.findIndex((x) => keyOf(x) === keyOf(v)); if (i >= 0) arr[i] = Object.assign({}, v); else arr.push(Object.assign({}, v)); return fakeReq; },
      delete: (k) => { const i = arr.findIndex((x) => keyOf(x) === k); if (i >= 0) arr.splice(i, 1); return fakeReq; }
    };
    const req = fn(fakeStore);
    return Promise.resolve(req && req.result !== undefined ? req.result : undefined);
  });
}

const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const getOne = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const put = (store, val) => tx(store, 'readwrite', (s) => s.put(val));
const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

/* ---------- Web 端本地用户（无登录系统时字段保留，接后端后可替换） ---------- */
export async function getLocalUser() {
  if (useCloud()) {
    try {
      const cu = await getCloudUser();
      if (cu) { await put('meta', { key: 'user', value: cu }); return cu; }
    } catch (e) { console.warn('[db] getCloudUser fallback to local', e); }
  }
  const m = await getOne('meta', 'user');
  if (m && m.value) return m.value;
  const user = {
    ownerId: 'web-' + uuid().slice(0, 8),
    nickName: '网页用户',
    customCategories: ['', '', '', '', '']
  };
  await put('meta', { key: 'user', value: user });
  return user;
}
export async function saveLocalUser(user) {
  await put('meta', { key: 'user', value: user });
  if (useCloud()) { try { await saveCloudUser(user); } catch (e) { console.warn('[db] saveCloudUser failed', e); } }
}

/* ---------- 新建 Todo 的默认结构（与小程序端 doCreate 对齐） ---------- */
export function newTodoDoc(partial, user) {
  const now = Date.now();
  const moduleType = partial.moduleType === 'categorized' ? 'categorized' : 'daily';
  return Object.assign({
    id: uuid(),
    title: '',
    titleCustom: false,
    titleStyle: null,
    moduleType,
    categoryId: moduleType === 'daily' ? 1 : 0,
    categoryName: moduleType === 'daily' ? '日常每天 Todo' : '未分类',
    targetDate: moduleType === 'daily' ? (partial.targetDate || todayStr()) : '',
    tasks: [],
    templateId: 'plain-paper',
    colorKey: 'mint',
    isShared: false,
    groupId: '',
    isDone: false,
    ownerId: user ? user.ownerId : 'web-local',
    lastEditedBy: user ? user.ownerId : 'web-local',
    lastEditedByName: user ? user.nickName : '网页用户',
    createTime: now,
    updateTime: now
  }, partial);
}

export const TodoRepository = {
  getTodos: () => (useCloud() ? CloudTodoRepository.getTodos() : getAll('todos')),
  getTodoById: (id) => (useCloud() ? CloudTodoRepository.getTodoById(id) : getOne('todos', id).then((v) => v || null)),
  createTodo: (todo) => (useCloud() ? CloudTodoRepository.createTodo(todo) : put('todos', todo)),
  updateTodo: (todo) => (useCloud() ? CloudTodoRepository.updateTodo(todo) : put('todos', todo)),
  deleteTodo: (id) => (useCloud() ? CloudTodoRepository.deleteTodo(id) : del('todos', id))
};

/* ---------- 本机数据一键上云（首次登录迁移 / 离线改动补传） ---------- */
export async function uploadLocalToCloud() {
  if (!useCloud()) throw new Error('云端未启用或未登录');
  const todos = await getAll('todos');
  const n = await CloudTodoRepository.upsertMany(todos);
  return n;
}
export { getAll as localGetAllTodos, del as localDelTodo };

/* ---------- 本地快照（云端不可用时兜底，保证页面一定能开） ---------- */
export async function localSnapshot() {
  const [todos, groups, user] = await Promise.all([getAll('todos'), getAll('groups'), getLocalUser()]);
  return { todos, groups, user };
}

/* ---------- 通用 meta（视图偏好/主题/批量规则/日历） ---------- */
export function getMeta(key, dflt) {
  return getOne('meta', key).then((m) => (m && m.value !== undefined ? m.value : dflt));
}
export function setMeta(key, value) {
  return put('meta', { key, value });
}

/* ---------- 群组：登录云端走 Supabase（跨设备），否则本机演示 ---------- */
export const GroupRepository = {
  getGroups: () => (useCloud() ? CloudGroupRepository.getMyGroups() : getAll('groups')),
  getGroupById: (id) => (useCloud() ? CloudGroupRepository.getGroupById(id) : getOne('groups', id).then((v) => v || null)),
  createGroup: (g) => (useCloud() ? CloudGroupRepository.createGroup(g) : put('groups', g)),
  deleteGroup: (id) => (useCloud() ? CloudGroupRepository.deleteGroup(id) : del('groups', id)),
  findByCode: (code) => (useCloud()
    ? CloudGroupRepository.findByCode(code)
    : getAll('groups').then((all) => all.find((g) => g.inviteCode === String(code || '').trim().toUpperCase()) || null)),
  joinByCode: async (code) => {
    if (useCloud()) return CloudGroupRepository.joinByCode(code);
    const all = await getAll('groups');
    const g = all.find((x) => x.inviteCode === String(code || '').trim().toUpperCase());
    if (!g) throw new Error('群组不存在：未登录云端时邀请码仅同机同浏览器有效；跨设备请先登录云端或在小程序端加入');
    return `已找到并加入「${g.name}」（本地演示）`;
  }
};

/* ---------- 数据导出 / 导入 ---------- */
export async function exportAll() {
  const [todos, groups] = await Promise.all([getAll('todos'), getAll('groups')]);
  const user = await getLocalUser();
  return { app: 'yiqi-todo-web', version: 1, exportedAt: Date.now(), user, todos, groups };
}
export async function importAll(data, mode = 'merge') {
  if (!data || !Array.isArray(data.todos)) throw new Error('文件格式不正确');
  if (mode === 'replace') {
    const todos = await getAll('todos');
    await Promise.all(todos.map((t) => del('todos', t.id)));
    const groups = await getAll('groups');
    await Promise.all(groups.map((g) => del('groups', g.id)));
  }
  for (const t of data.todos) {
    if (t && t.id) await put('todos', t);
  }
  for (const g of (data.groups || [])) {
    if (g && g.id) await put('groups', g).catch(() => { /* 邀请码冲突跳过 */ });
  }
  return data.todos.length;
}
