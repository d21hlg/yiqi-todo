/* 数据访问层 —— IndexedDB（PWA 离线可用）
 * 抽象接口 TodoRepository：getTodos / getTodoById / createTodo / updateTodo / deleteTodo
 * 小程序端走微信云开发（云函数+云数据库），Web 端走 IndexedDB；两端数据模型字段一致，
 * 未来接入同一后端时只需替换本文件的实现，业务层（app.js/paper.js/util.js）不动。
 */
import { uuid, todayStr } from './util.js';

const DB_NAME = 'yiqi-todo-web';
const DB_VER = 1;
let dbPromise = null;

function openDB() {
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
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result !== undefined ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const getOne = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const put = (store, val) => tx(store, 'readwrite', (s) => s.put(val));
const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

/* ---------- Web 端本地用户（无登录系统时字段保留，接后端后可替换） ---------- */
export async function getLocalUser() {
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
  getTodos: () => getAll('todos'),
  getTodoById: (id) => getOne('todos', id).then((v) => v || null),
  createTodo: (todo) => put('todos', todo),
  updateTodo: (todo) => put('todos', todo),
  deleteTodo: (id) => del('todos', id)
};

/* ---------- 群组（Web 端本地演示实现；字段与小程序一致，待接后端同步） ---------- */
export const GroupRepository = {
  getGroups: () => getAll('groups'),
  getGroupById: (id) => getOne('groups', id).then((v) => v || null),
  createGroup: (g) => put('groups', g),
  deleteGroup: (id) => del('groups', id),
  findByCode: async (code) => {
    const all = await getAll('groups');
    return all.find((g) => g.inviteCode === String(code || '').trim().toUpperCase()) || null;
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
