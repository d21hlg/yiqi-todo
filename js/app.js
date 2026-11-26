/* app.js —— 网页版路由与视图（今日 / 专题 / 编辑 / 群组 / 我的）
 * 功能规则与微信小程序端一致：单日聚焦、专题筛选（月/日/类别/关键词/重置）、
 * 整篇标题、checkbox 可选、首页卡片只显示标题+进度、模板、分类、共享字段、群组。
 */
import {
  PRESET_CATEGORIES, TODO_TEMPLATES, templateMeta, getDefaultTemplateByCategory, categoryOptions,
  getTodoTitlePreview, getTodoDate, filterTodos, tasksStat, isTodoCompleted, normalizeTasks,
  todayStr, shiftDate, dayInfo, fmtMinute, daysInMonth, tsToDateStr, esc, debounce, uid, formatDailyTodoTitle, getDailyTodoByDate, dailyHasContent, mergeDuplicateDailyTodos
} from './util.js';
import { TodoRepository, GroupRepository, getLocalUser, saveLocalUser, newTodoDoc, exportAll, importAll, uploadLocalToCloud } from './db.js';
import { USE_SUPABASE } from './config.js';
import { initAuth, supaState, signInWithEmail, signOutCloud, verifyWithCode, signInWithPasswordOrSignup, CloudTodoRepository, CloudGroupRepository } from './supabase-db.js';
import { createPaperEditor } from './paper.js';
import { getTodoProgress, weekUnfinishedDates, fmtShortDate, sortTopicTodos, THEMES, THEME_BGS, datesForRule, hasTaskFromRule, defaultCalendar, isChinaLegalHoliday, safeTasksArray } from './util.js';
import { getMeta, setMeta, localSnapshot, getTombstones, localPutTodo, localDelTodo } from './db.js';

const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
const toastEl = document.getElementById('toast');
const offlineEl = document.getElementById('offline');

console.log('[App] root render start (module loaded)');
const state = {
  user: null,
  todos: [],
  groups: [],
  daily: { date: todayStr(), viewMode: 'tasks', doc: null, editor: null, draftId: null, creating: false },
  filters: { selectedMonth: '', selectedDay: '', selectedCategoryId: null, keyword: '' },
  edit: null, // { doc, isNew, editor, saveTimer, dirty }
  pref: { dailyMode: 'tasks', cateMode: 'expanded', lastCateTodoId: '' }, // 专题默认放大版（记忆上次浏览；无记录自动回缩小版）
  theme: { themeId: 'morandi-green', bgId: 'none' },
  bulkRules: [],
  workdayCal: null,
  cate: { doc: null, editor: null }
};

/* ---------- v2.3 主题 / 偏好 ---------- */
function applyTheme() {
  const t = state.theme || { themeId: 'cream', bgId: 'none' };
  document.documentElement.setAttribute('data-theme', t.themeId || 'cream');
  document.documentElement.setAttribute('data-bg', t.bgId || 'none');
}
async function loadPrefs() {
  try {
  const [pref, theme, rules, cal] = await Promise.all([
    getMeta('viewPref', null), getMeta('theme', null), getMeta('bulkRules', null), getMeta('workdayCal', null)
  ]);
  if (pref) state.pref = Object.assign(state.pref, pref);
  if (theme) state.theme = Object.assign(state.theme, theme);
  if (rules) state.bulkRules = rules;
  const yy = new Date().getFullYear();
  let wcal = cal;
  if (!wcal || ((!wcal.holidays || !wcal.holidays.length) && (!wcal.extraWorkdays || !wcal.extraWorkdays.length) && !wcal.userEdited)) {
    wcal = defaultCalendar(yy); // 内置中国日历；未内置年份 configured=false → 界面提示
  }
  state.workdayCal = wcal;
  state.daily.viewMode = state.pref.dailyMode === 'compact' ? 'compact' : 'tasks';
  state.daily.date = state.daily.date || todayStr();
  applyTheme();
  } catch (e) {
    console.error('[Prefs] load failed:', e);
    state.daily.viewMode = 'tasks';
    state.daily.date = state.daily.date || todayStr();
    applyTheme();
  }
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hide');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hide'), 1800);
}
window.__toast = toast;

function sanitizeTodos(list) {
  const arr = Array.isArray(list) ? list : [];
  arr.forEach((t) => {
    if (!t || typeof t !== 'object') return;
    if (!Array.isArray(t.tasks)) {
      console.error('[DataRepair] todo.tasks 非数组，读时修复:', t.id, typeof t.tasks);
      t.tasks = safeTasksArray(t.tasks);
      TodoRepository.updateTodo(t).catch(() => {});
    }
  });
  return arr;
}

async function reloadAll() {
  // v2.5 本地优先：永远先读本机（无网络依赖、秒开）；云端由后台同步引擎合并
  const snap = await localSnapshot();
  state.todos = sanitizeTodos(snap.todos);
  state.groups = Array.isArray(snap.groups) ? snap.groups : [];
  state.user = snap.user;
}

/* ================= v2.5 后台云同步引擎（静默、可达才写、LWW 合并） ================= */
let syncRunning = false;
let syncBadgeEl = null;
let lastSyncAt = 0;
function setBadge(mode) {
  if (!syncBadgeEl) {
    syncBadgeEl = document.createElement('div');
    syncBadgeEl.id = 'sync-badge';
    syncBadgeEl.onclick = () => { toast('正在尝试连接云端…'); tryCloudSync(); };
    document.body.appendChild(syncBadgeEl);
  }
  if (!USE_SUPABASE || !supaState().active) { syncBadgeEl.style.display = 'none'; return; }
  syncBadgeEl.style.display = '';
  if (mode === 'ok') syncBadgeEl.textContent = '☁ 已同步';
  else if (mode === 'sync') syncBadgeEl.textContent = '☁ 同步中…';
  else syncBadgeEl.textContent = '⚠ 单机模式 · 点我重试';
}
async function tryCloudSync() {
  if (!USE_SUPABASE || !supaState().active) { setBadge('off'); return; }
  if (syncRunning) return;
  syncRunning = true;
  setBadge('sync');
  try {
    const cloudTodos = await CloudTodoRepository.getTodos(); // 能走到这里=云端可达
    const local = sanitizeTodos((await localSnapshot()).todos);
    const tombs = await getTombstones();
    for (const tb of tombs) { await CloudTodoRepository.deleteTodo(tb.id).catch(() => {}); }
    for (const lt of local) {
      const ct = cloudTodos.find((c) => c.id === lt.id);
      if (!ct) await CloudTodoRepository.createTodo(lt);
      else if ((lt.updateTime || 0) > (ct.updateTime || 0)) await CloudTodoRepository.updateTodo(lt);
    }
    const fresh = sanitizeTodos(await CloudTodoRepository.getTodos());
    const freshIds = {};
    fresh.forEach((t) => { freshIds[t.id] = 1; });
    // 其他设备删除的（且本机自上次同步后没碰过）→ 本地也删
    const prevSync = lastSyncAt;
    for (const lt of local) {
      if (!freshIds[lt.id] && (lt.updateTime || 0) <= prevSync) await localDelTodo(lt.id);
    }
    for (const t of fresh) await localPutTodo(t);
    state.todos = fresh;
    try { state.groups = await CloudGroupRepository.getMyGroups(); } catch (e) { /* 群组保留本地 */ }
    lastSyncAt = Date.now();
    window.__cloudOk = true;
    setBadge('ok');
    console.log('[Sync] cloud ok, todos:', fresh.length);
  } catch (e) {
    window.__cloudOk = false;
    setBadge('local');
    console.warn('[Sync] cloud unreachable:', e && e.message);
  } finally {
    syncRunning = false;
  }
}
function queueSync() { setTimeout(() => tryCloudSync(), 300); }
setInterval(() => tryCloudSync(), 45000);
window.addEventListener('online', () => queueSync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) queueSync(); });

/* ================= 路由 ================= */
function parseHash() {
  const h = (location.hash || '#/daily').replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const parts = path.split('/').filter(Boolean); // ['edit','id']
  const params = new URLSearchParams(query || '');
  return { parts, params };
}

async function render() {
  let parts, params;
  try {
  ({ parts, params } = parseHash());
  flushEditSave();
  flushDailySave();
  flushCateSave();
  const editingDraft = parts[0] === 'edit' && state.daily.draftId && parts[1] === state.daily.draftId;
  if (!editingDraft) cleanupDailyDraft();
  if (state.edit && state.edit.editor) { state.edit.editor.destroy(); state.edit.editor = null; }
  destroyDailyEditor();
  state.edit = null;
  await reloadAll();

  const route = parts[0] || 'daily';
  document.querySelectorAll('#tabbar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === route);
  });

  {
    if (route === 'daily') renderDaily();
    else if (route === 'cate') renderCate();
    else if (route === 'groups') renderGroups();
    else if (route === 'mine') renderMine();
    else if (route === 'edit') await renderEdit(parts[1], params);
    else renderDaily();
  }
  window.__booted = true;
  if (USE_SUPABASE && supaState().active && window.__cloudOk !== true) queueSync();
  } catch (err) {
    console.error('[DailyPage] load failed:', err);
    window.__booted = true; // 错误边界也算启动成功（有可见反馈）
    try {
      view.innerHTML = `<div class="card empty">
        <div>页面加载失败</div>
        <div class="t-mut" style="margin:8px 0">${esc(String((err && err.message) || err))}</div>
        <button class="btn primary" id="r-retry">重试</button>
      </div>`;
      const rb = document.getElementById('r-retry');
      if (rb) rb.onclick = () => render();
    } catch (_) { /* 视图容器都不可用时至少控制台有日志 */ }
  }

  window.scrollTo(0, 0);
}
window.addEventListener('error', (ev) => {
  console.error('[GlobalError]', ev.message, ev.filename, ev.lineno);
  if (window.__toast) window.__toast('页面异常：' + ev.message);
});
window.addEventListener('hashchange', () => {
  console.log('[Navigation] hashchange:', location.hash);
  render();
});
document.addEventListener('click', (e) => {
  const tab = e.target.closest && e.target.closest('#tabbar a');
  if (tab) console.log('[Navigation] tab click:', tab.dataset.tab, tab.getAttribute('href'));
}, true);

/* ================= 通用：Todo 卡片 ================= */
function todoCardHtml(todo) {
  const st = tasksStat(todo.tasks);
  const badges = [];
  if (todo.isPinned) badges.push('<span class="badge share">置顶</span>');
  if (todo.isShared) badges.push('<span class="badge share">共享</span>');
  if (todo.isDone) badges.push('<span class="badge done">已完成</span>');
  const cat = todo.moduleType === 'categorized' && todo.categoryId ? `<span>${esc(todo.categoryName || '')}</span>` : '';
  return `<div class="card todo-card" data-id="${todo.id}">
    <div class="title">${isTodoCompleted(todo) ? '<span class="todo-completed-label">【已完成】</span>' : ''}${esc(getTodoTitlePreview(todo, 24))}</div>
    <div class="meta">
      ${badges.join('')}
      ${cat}
      ${st.total ? `<span>已完成 ${st.done}/${st.total}</span>` : '<span>无勾选框任务</span>'}
      <span class="spacer"></span>
      <span>${esc(fmtMinute(todo.updateTime || todo.createTime))}</span>
    </div>
    <div class="card-progress"><div class="fill" style="width:${st.percent}%"></div></div>
  </div>`;
}

function bindCards(container) {
  container.addEventListener('click', (e) => {
    const card = e.target.closest('.todo-card');
    if (card) location.hash = '#/edit/' + card.dataset.id;
  });
}

/** template id → 纸张类名（装饰边框 + 纸张底纹 lines/grid/dots） */
function paperClassOf(tplId) {
  const m = templateMeta(tplId) || {};
  return (m.cls ? m.cls + ' ' : '') + (m.paper && m.paper !== 'plain' ? 'ps-' + m.paper : '');
}

/* ============ 今日（v2.0：每天仅一篇 daily Todo，默认直接展开 tasks） ============ */
let dailyMergeDone = false;
let dailySave = null; // { timer, dirty, doc, editor }

/** 旧数据兼容：同一天多篇 daily 自动合并落库（tasks 串接进最早一篇，其余删除；幂等） */
async function persistDailyMerge() {
  if (dailyMergeDone) return;
  const merged = mergeDuplicateDailyTodos(state.todos);
  const dups = merged.filter((t) => t._mergedFrom && t._mergedFrom.length > 1);
  if (!dups.length) return;
  dailyMergeDone = true;
  try {
    for (const g of dups) {
      const first = state.todos.find((t) => t.id === g._mergedFrom[0]);
      if (!first) continue;
      first.tasks = g.tasks;
      first.title = formatDailyTodoTitle(g.targetDate);
      first.titleCustom = true;
      first.createTime = g.createTime;
      first.updateTime = g.updateTime;
      first.isDone = isTodoCompleted(g.tasks);
      await TodoRepository.updateTodo(first);
      for (const id of g._mergedFrom.slice(1)) {
        await TodoRepository.deleteTodo(id);
        state.todos = state.todos.filter((t) => t.id !== id);
      }
    }
    destroyDailyEditor();
    toast('已自动合并同一天的重复 Todo');
    renderDaily();
  } catch (e) {
    dailyMergeDone = false;
    toast('合并失败：' + e.message);
  }
}

/** 懒创建：只有点「＋ 添加任务」才创建当天唯一一篇 Todo（标题=YYYYMMDD）；打开/切换日期不创建空 Todo */
async function createDailyDoc() {
  if (state.daily.creating) return;
  state.daily.creating = true;
  try {
    const date = state.daily.date;
    const tpl = getDefaultTemplateByCategory(1);
    const doc = newTodoDoc({
      moduleType: 'daily',
      targetDate: date,
      title: formatDailyTodoTitle(date),
      titleCustom: true,
      templateId: tpl,
      paperStyle: (templateMeta(tpl) || {}).paper || 'plain',
      tasks: [{ id: uid('t'), text: '', completed: false, hasCheckbox: true }]
    }, state.user);
    await TodoRepository.createTodo(doc);
    state.todos.push(doc);
    state.daily.draftId = doc.id; // 始终没输入内容则离开时回收，保证不留空 Todo
    return doc;
  } finally {
    state.daily.creating = false;
  }
}

function scheduleDailySave() {
  if (!dailySave) return;
  dailySave.dirty = true;
  clearTimeout(dailySave.timer);
  dailySave.timer = setTimeout(() => { flushDailySave(); }, 700);
}

/** 自动保存当天 Todo：daily 标题锁死为日期，不接受编辑器标题修改 */
async function flushDailySave() {
  if (!dailySave || !dailySave.dirty) return;
  const { doc, editor } = dailySave;
  dailySave.dirty = false;
  const tasks = normalizeTasks(editor.getPayload().tasks);
  doc.tasks = tasks;
  doc.isDone = isTodoCompleted(tasks);
  doc.updateTime = Date.now();
  doc.lastEditedBy = state.user ? state.user.ownerId : '';
  doc.lastEditedByName = state.user ? state.user.nickName : '';
  doc.title = formatDailyTodoTitle(doc.targetDate);
  doc.titleCustom = true;
  try {
    await TodoRepository.updateTodo(doc);
    queueSync(); // v2.6：落库后触发后台云同步
    const i = state.todos.findIndex((t) => t.id === doc.id);
    if (i >= 0) state.todos[i] = doc;
    if (state.daily.draftId === doc.id && tasks.some((t) => (t.text || '').trim())) state.daily.draftId = null;
  } catch (e) {
    dailySave.dirty = true;
    toast('保存失败：' + e.message);
  }
}

function destroyDailyEditor() {
  if (state.daily.editor) { state.daily.editor.destroy(); state.daily.editor = null; }
  if (dailySave) { clearTimeout(dailySave.timer); dailySave = null; }
  window.__flushDailySave = null;
}

/** 懒创建后始终没有任何输入的空草稿 → 切日期/切视图/离开路由时删除 */
function cleanupDailyDraft() {
  const st = state.daily;
  if (!st.draftId) return;
  let tasks = [];
  if (st.editor) tasks = normalizeTasks(st.editor.getPayload().tasks);
  else if (dailySave && dailySave.doc) tasks = dailySave.doc.tasks || [];
  const hasText = tasks.some((t) => (t.text || '').trim());
  const id = st.draftId;
  st.draftId = null;
  if (!hasText) {
    TodoRepository.deleteTodo(id);
    state.todos = state.todos.filter((t) => t.id !== id);
  }
}

function updateProgressDom(prefix, tasks) {
  const p = getTodoProgress({ tasks });
  const pct = document.getElementById(prefix + '-pct');
  if (!pct) return;
  pct.textContent = p.progressPercent + '%';
  const st = document.getElementById(prefix + '-stat');
  if (st) st.textContent = p.completedTasks + ' / ' + p.totalTasks + ' 项带勾选框任务';
  const fl = document.getElementById(prefix + '-fill');
  if (fl) fl.style.width = p.progressPercent + '%';
}

function renderDaily() {
  const d = state.daily.date || todayStr();
  state.daily.date = d;
  const info = dayInfo(d);
  const isToday = d === todayStr();
  document.body.classList.remove('editing');
  destroyCateEditor();

  const allDaily = state.todos.filter((t) => t.moduleType === 'daily');
  const mergedAll = mergeDuplicateDailyTodos(allDaily);
  const dayTodo = getDailyTodoByDate(mergedAll, d);
  if (dayTodo && dayTodo._mergedFrom) delete dayTodo._mergedFrom;
  const compactList = mergedAll.filter(dailyHasContent).map((t) => {
    const s = getTodoProgress(t);
    return {
      id: t.id,
      title: (t.title || '').trim() || formatDailyTodoTitle(t.targetDate),
      date: t.targetDate,
      done: s.completedTasks, total: s.totalTasks, percent: s.progressPercent,
      doneAll: isTodoCompleted(t)
    };
  }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const stat = dayTodo ? getTodoProgress(dayTodo) : null;
  const week = weekUnfinishedDates(state.todos, todayStr());
  console.log('[DailyPage] selectedDate:', d, 'viewMode:', state.daily.viewMode, 'dailyTodo:', dayTodo ? dayTodo.id : null);

  const head = `
    <div class="date-head">
      <button class="arrow-btn" id="d-prev">‹</button>
      <div>
        <div class="big-date">${esc(info.label)}</div>
        <div class="sub">${esc(d)} ${esc(info.week)}</div>
      </div>
      <button class="arrow-btn" id="d-next">›</button>
      <input type="date" id="d-pick" value="${d}" />
      ${isToday ? '' : '<button class="arrow-btn" id="d-today">回到今天</button>'}
      <div class="spacer"></div>
      <button class="btn" id="d-mode">${state.daily.viewMode === 'tasks' ? '切换为缩小版' : '切换为展开视图'}</button>
      ${state.daily.viewMode === 'tasks' ? '<button class="btn primary" id="d-add">＋ 添加任务</button>' : ''}
    </div>`;
  const weekRow = week.length ? `
    <div class="card week-chips">
      <span class="lbl">过去一周还有未完成：</span>
      ${week.map((w) => `<button class="chip-btn" data-wdate="${w.date}">${fmtShortDate(w.date)}　${w.count} 项未完成</button>`).join('')}
    </div>` : '';

  if (state.daily.viewMode === 'compact') {
    destroyDailyEditor();
    view.innerHTML = head + weekRow + `
      <div id="d-compact">
        ${compactList.length ? compactList.map((c) => `
        <div class="card daily-compact-card" data-date="${esc(c.date)}">
          <div class="dcc-row">
            <span class="dcc-title">${c.doneAll ? '<span class="todo-completed-label">【已完成】</span>' : ''}${esc(c.title)}</span>
            <span class="dcc-stat">完成 ${c.done} / ${c.total} · ${c.percent}%</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${c.percent}%"></div></div>
        </div>`).join('') : '<div class="empty">还没有带任务的每日 Todo，切回展开视图添加第一条任务</div>'}
      </div>`;
    bindDailyHead(d);
    bindWeekChips();
    document.getElementById('d-compact').addEventListener('click', (e) => {
      const card = e.target.closest('.daily-compact-card');
      if (!card) return;
      state.daily.date = card.dataset.date;
      state.daily.viewMode = 'tasks';
      state.pref.dailyMode = 'tasks';
      setMeta('viewPref', state.pref);
      renderDaily();
    });
    persistDailyMerge();
    return;
  }

  /* 展开视图：只读 task list（可勾选），编辑能力点「修改 ›」进入 */
  view.innerHTML = head + weekRow + `
    <div class="todo-page ${dayTodo ? paperClassOf(dayTodo.templateId) : ''}" id="d-page">
      <div class="card progress-card mini-progress" id="d-progcard" ${dayTodo ? '' : 'hidden'}>
        <div class="row"><span class="pct" id="d-pct">${stat ? stat.progressPercent : 0}%</span><div class="spacer"></div>
        <span id="d-stat">${stat ? stat.completedTasks + ' / ' + stat.totalTasks : '0 / 0'} 项带勾选框任务</span></div>
        <div class="progress-track"><div class="progress-fill" id="d-fill" style="width:${stat ? stat.progressPercent : 0}%"></div></div>
      </div>
      ${dayTodo ? `<div id="daily-mount"></div>
        <div class="card todo-bottom-actions" id="d-bottom">
          <button class="btn" data-bpan="tpl">模板</button>
          <button class="btn" data-bpan="share">共享</button>
          <button class="btn" data-bpan="more">更多</button>
        </div>
        <div class="tool-pan pan-slot" id="d-bslot" hidden></div>
        <div class="daily-open-row"><a class="btn sm" href="#/edit/${dayTodo.id}">整篇设置 / 跳转详情页 ›</a></div>`
      : `<div class="empty" id="daily-empty">
          <div>${isToday ? '今日还没有任务' : '这一天还没有任务'}</div>
          <div class="t-mut">添加第一条任务时才会创建当天 Todo（标题自动为 ${esc(formatDailyTodoTitle(d))}；查看日期不会创建空 Todo）</div>
          <button class="btn primary" id="d-add-first">＋ 添加任务</button>
        </div>`}
    </div>`;

  bindDailyHead(d);
  bindWeekChips();
  persistDailyMerge();

  const addBtn = document.getElementById('d-add-first');
  if (addBtn) {
    addBtn.onclick = async () => {
      console.log('[AddTask] clicked (empty state), selectedDate:', d);
      try {
        const doc = await createDailyDoc(); // 当天没有 → 创建唯一一篇
        renderDaily();                       // 立即内联显示，无需刷新/跳转
        const el = document.querySelector('#daily-mount .task-content');
        if (el) el.focus();                  // 新行自动聚焦
      } catch (e) {
        console.error('[AddTask] create failed:', e);
        toast('创建失败：' + ((e && e.message) || e));
      }
    };
    destroyDailyEditor();
    return;
  }
  const headAdd = document.getElementById('d-add');
  if (headAdd) {
    headAdd.onclick = () => {
      console.log('[AddTask] clicked (head), selectedDate:', d);
      if (state.daily.editor && state.daily.editor.addRow) state.daily.editor.addRow();
      else toast('编辑器未就绪，请重试');
    };
  }

  if (state.daily.editor && dailySave && dailySave.doc && dailySave.doc.id === dayTodo.id) return;
  destroyDailyEditor();
  state.daily.editor = createPaperEditor({
    mount: document.getElementById('daily-mount'),
    hideTitle: true,
    editable: true, // v2.3.2 hotfix：放大版=可编辑+一级编辑栏可点开（上轮只读化是回归根因）
    paperClass: '', // 模板样式由整页容器 .todo-page 承载，避免双层背景
    initial: { title: '', titleStyle: null, tasks: dayTodo.tasks || [] },
    onChange: (payload) => { updateProgressDom('d', payload.tasks); scheduleDailySave(); }
  });
  bindBottomActions('d-bottom', 'd-bslot',
    makePanelOpener(() => state.daily.editor, () => (dailySave && dailySave.doc) || dayTodo, () => scheduleDailySave()));
  dailySave = { timer: 0, dirty: false, doc: dayTodo, editor: state.daily.editor };
  window.__flushDailySave = flushDailySave;
}

function bindWeekChips() {
  view.querySelectorAll('[data-wdate]').forEach((b) => {
    b.onclick = () => {
      flushDailySave();
      cleanupDailyDraft();
      state.daily.date = b.dataset.wdate;
      state.daily.viewMode = 'tasks';
      state.pref.dailyMode = 'tasks';
      setMeta('viewPref', state.pref);
      renderDaily();
    };
  });
}

/* ---------- 专题放大版自动保存 ---------- */
let cateSave = null;
function scheduleCateSave() {
  if (!cateSave) return;
  cateSave.dirty = true;
  clearTimeout(cateSave.timer);
  cateSave.timer = setTimeout(flushCateSave, 700);
}
async function flushCateSave() {
  if (!cateSave || !cateSave.dirty) return;
  cateSave.dirty = false;
  const doc = cateSave.doc;
  const payload = cateSave.editor.getPayload();
  doc.tasks = normalizeTasks(payload.tasks);
  doc.isDone = isTodoCompleted(doc.tasks);
  doc.updateTime = Date.now();
  doc.lastEditedBy = state.user.ownerId;
  doc.lastEditedByName = state.user.nickName;
  try { await TodoRepository.updateTodo(doc); queueSync(); } catch (e) { toast('保存失败：' + e.message); }
}
function destroyCateEditor() {
  if (cateSave) { clearTimeout(cateSave.timer); if (cateSave.editor) cateSave.editor.destroy(); }
  cateSave = null;
  state.cate.doc = null;
  state.cate.editor = null;
}

function bindDailyHead(d) {
  const set = (date) => {
    flushDailySave();
    cleanupDailyDraft();
    state.daily.date = date;
    renderDaily();
  };
  document.getElementById('d-prev').onclick = () => set(shiftDate(d, -1));
  document.getElementById('d-next').onclick = () => set(shiftDate(d, 1));
  const tb = document.getElementById('d-today');
  if (tb) tb.onclick = () => set(todayStr());
  document.getElementById('d-pick').onchange = (e) => { if (e.target.value) set(e.target.value); };
  document.getElementById('d-mode').onclick = () => {
    flushDailySave();
    cleanupDailyDraft();
    state.daily.viewMode = state.daily.viewMode === 'tasks' ? 'compact' : 'tasks';
    state.pref.dailyMode = state.daily.viewMode;
    setMeta('viewPref', state.pref);
    renderDaily();
  };
}

function renderCate() {
  document.body.classList.remove('editing');
  destroyDailyEditor();
  destroyCateEditor();
  const opts = categoryOptions(state.user.customCategories);
  const f = state.filters;
  const mode = state.pref.cateMode === 'expanded' ? 'expanded' : 'compact';

  view.innerHTML = `
    <div class="card">
      <div class="row" style="flex-wrap:wrap">
        <span class="lbl">月份</span>
        <input type="month" id="f-month" value="${esc(f.selectedMonth)}" />
        <span class="lbl">日期</span>
        <select id="f-day"><option value="">不限</option>${
          Array.from({ length: f.selectedMonth ? daysInMonth(f.selectedMonth) : 31 }, (_, i) => i + 1)
            .map((dd) => `<option value="${String(dd).padStart(2, '0')}" ${f.selectedDay === String(dd).padStart(2, '0') ? 'selected' : ''}>${dd} 日</option>`).join('')
        }</select>
      </div>
      <div class="row" style="flex-wrap:wrap;margin-top:10px">
        <span class="lbl">类别</span>
        <select id="f-cat">
          <option value="">全部类别</option>
          ${opts.map((o) => `<option value="${o.id}" ${String(f.selectedCategoryId) === String(o.id) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
        </select>
        <input class="cat-input" id="f-kw" placeholder="关键词搜索" value="${esc(f.keyword)}" style="flex:1" />
        <button class="btn ghost" id="f-reset">重置筛选</button>
        <div class="spacer"></div>
        <button class="btn" id="f-mode">${mode === 'compact' ? '切换为放大版' : '切换为缩小版'}</button>
        <button class="btn" id="f-new">＋ 新建</button>
      </div>
    </div>
    <div id="c-body"></div>`;

  const monthEl = document.getElementById('f-month');
  const dayEl = document.getElementById('f-day');
  const catEl = document.getElementById('f-cat');
  const kwEl = document.getElementById('f-kw');

  function filteredList() {
    const month = monthEl.value;
    const day = dayEl.value;
    const selectedDate = month && day ? `${month}-${day}` : '';
    const catId = catEl.value === '' ? null : Number(catEl.value);
    return filterTodos(
      state.todos.filter((t) => t.moduleType === 'categorized'),
      { selectedMonth: month, selectedDate, selectedCategoryId: catId, keyword: kwEl.value }
    );
  }

  function updateList() {
    const body = document.getElementById('c-body');
    const list = filteredList();
    if (mode === 'compact') {
      const sorted = sortTopicTodos(list);
      body.innerHTML = sorted.length
        ? sorted.map(todoCardHtml).join('')
        : '<div class="empty">没有符合条件的专题 Todo（专题不记录开始/结束日，只按创建与修改时间管理）</div>';
      body.onclick = (e) => {
        const card = e.target.closest('.todo-card');
        if (!card) return;
        state.pref.lastCateTodoId = card.dataset.id;
        state.pref.cateMode = 'expanded';
        setMeta('viewPref', state.pref);
        renderCate();
      };
      return;
    }
    /* 放大版：默认打开上一次浏览的专题 Todo */
    let doc = state.todos.find((t) => t.id === state.pref.lastCateTodoId && t.moduleType === 'categorized');
    if (!doc || (list.length && !list.some((t) => t.id === doc.id))) doc = list[0];
    if (!doc) {
      // 空数据/上次记录的 Todo 已删除 → 回缩小版；必须走 renderCate 重读偏好，
      // 不能递归 updateList（mode 常量未变会死循环，导致专题页栈溢出白屏）
      state.pref.cateMode = 'compact';
      setMeta('viewPref', state.pref);
      renderCate();
      return;
    }
    const stat = getTodoProgress(doc);
    body.innerHTML = `
      <div class="card row" style="flex-wrap:wrap">
        <b>${doc.isPinned ? '<span class="badge share">置顶</span>' : ''}${esc(getTodoTitlePreview(doc, 30))}</b>
        <div class="spacer"></div>
        <select id="c-pick" class="cat-input" style="max-width:40%">
          ${sortTopicTodos(list).map((t) => `<option value="${t.id}" ${t.id === doc.id ? 'selected' : ''}>${esc(getTodoTitlePreview(t, 18))}</option>`).join('')}
        </select>
        <button class="btn sm" id="c-pin">${doc.isPinned ? '取消置顶' : '置顶'}</button>
        <a class="btn sm" href="#/edit/${doc.id}">修改 / 模板 / 共享 ›</a>
      </div>
      <div class="todo-page ${paperClassOf(doc.templateId)}" id="c-page">
        <div class="card progress-card mini-progress">
          <div class="row"><span class="pct" id="c-pct">${stat.progressPercent}%</span><div class="spacer"></div>
          <span id="c-stat">${stat.completedTasks} / ${stat.totalTasks} 项带勾选框任务</span></div>
          <div class="progress-track"><div class="progress-fill" id="c-fill" style="width:${stat.progressPercent}%"></div></div>
        </div>
        <div id="cate-mount"></div>
        <div class="card todo-bottom-actions" id="c-bottom">
          <button class="btn" data-bpan="tpl">模板</button>
          <button class="btn" data-bpan="share">共享</button>
          <button class="btn" data-bpan="more">更多</button>
        </div>
        <div class="tool-pan pan-slot" id="c-bslot" hidden></div>
      </div>`;
    document.getElementById('c-pick').onchange = (e) => {
      state.pref.lastCateTodoId = e.target.value;
      setMeta('viewPref', state.pref);
      renderCate();
    };
    document.getElementById('c-pin').onclick = async () => {
      doc.isPinned = !doc.isPinned;
      doc.pinnedAt = doc.isPinned ? new Date().toISOString() : '';
      doc.updateTime = Date.now();
      await TodoRepository.updateTodo(doc);
      toast(doc.isPinned ? '已置顶' : '已取消置顶');
      renderCate();
    };
    const editor = createPaperEditor({
      mount: document.getElementById('cate-mount'),
      hideTitle: true,
      editable: true,
      paperClass: '',
      initial: { title: '', titleStyle: null, tasks: doc.tasks || [] },
      onChange: (payload) => { updateProgressDom('c', payload.tasks); scheduleCateSave(); }
    });
    bindBottomActions('c-bottom', 'c-bslot',
      makePanelOpener(() => state.cate.editor, () => (cateSave && cateSave.doc) || doc, () => scheduleCateSave()));
    cateSave = { timer: 0, dirty: false, doc, editor };
    state.cate.doc = doc;
    state.cate.editor = editor;
  }

  monthEl.onchange = () => {
    state.filters.selectedMonth = monthEl.value;
    const n = monthEl.value ? daysInMonth(monthEl.value) : 31;
    dayEl.innerHTML = '<option value="">不限</option>' + Array.from({ length: n }, (_, i) => `<option value="${String(i + 1).padStart(2, '0')}">${i + 1} 日</option>`).join('');
    state.filters.selectedDay = '';
    updateList();
  };
  dayEl.onchange = () => { state.filters.selectedDay = dayEl.value; updateList(); };
  catEl.onchange = () => { state.filters.selectedCategoryId = catEl.value === '' ? null : Number(catEl.value); updateList(); };
  kwEl.oninput = debounce(() => { state.filters.keyword = kwEl.value; updateList(); }, 350);
  document.getElementById('f-reset').onclick = () => {
    state.filters = { selectedMonth: '', selectedDay: '', selectedCategoryId: null, keyword: '' };
    renderCate();
  };
  document.getElementById('f-mode').onclick = () => {
    flushCateSave();
    state.pref.cateMode = mode === 'compact' ? 'expanded' : 'compact';
    setMeta('viewPref', state.pref);
    renderCate();
  };
  document.getElementById('f-new').onclick = () => { location.hash = '#/edit/new?module=categorized'; };
  updateList();
}

/* ---------- v2.4 Todo 下方独立设置区（模板/共享/更多），与文字编辑栏分离 ---------- */
function bindBottomActions(barId, slotId, opener) {
  const bar = document.getElementById(barId);
  const slot = document.getElementById(slotId);
  if (!bar || !slot) return;
  let active = '';
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bpan]');
    if (!b) return;
    const id = b.dataset.bpan;
    console.log('[BottomBar] panel:', id);
    if (active === id) {
      slot.hidden = true;
      active = '';
      bar.querySelectorAll('[data-bpan]').forEach((x) => x.classList.remove('on'));
      return;
    }
    active = id;
    bar.querySelectorAll('[data-bpan]').forEach((x) => x.classList.toggle('on', x === b));
    slot.innerHTML = '';
    slot.hidden = false;
    opener(id, slot);
  });
}

/* ---------- v2.3.2 共享面板生成器：今日/专题放大版的编辑工具面板 ---------- */
function makePanelOpener(getEditor, getDoc, afterChange) {
  return (id, slot) => {
    const editor = getEditor();
    const doc = getDoc();
    if (!doc || !editor) return;
    if (id === 'tpl') {
      slot.innerHTML = `<div class="pan-lbl">模板（仅名称）</div>
        <div class="tpl-names">${TODO_TEMPLATES.map((t) => `<button class="chip-btn ${doc.templateId === t.id ? 'on' : ''}" data-tpl="${t.id}">${esc(t.name)}</button>`).join('')}</div>`;
      slot.onclick = (e) => {
        const b = e.target.closest('[data-tpl]');
        if (!b) return;
        doc.templateId = b.dataset.tpl;
        editor.setPaperAppearance(paperClassOf(doc.templateId));
        const pg = slot.closest('.todo-page');
        if (pg) {
          pg.className = pg.className.split(/\s+/).filter((c) => !/^tpl-/.test(c) && !/^ps-/.test(c)).join(' ') + ' ' + paperClassOf(doc.templateId);
        }
        slot.querySelectorAll('[data-tpl]').forEach((x) => x.classList.toggle('on', x === b));
        afterChange();
      };
    } else if (id === 'share') {
      slot.innerHTML = `<div class="pan-lbl">共享设置</div>
        <div class="form-row"><span class="lbl">是否共享</span><div class="switch ${doc.isShared ? 'on' : ''}" id="p-share"></div></div>
        <div class="form-row"><select id="p-group" ${doc.isShared ? '' : 'disabled'}>
          <option value="">选择群组…</option>
          ${state.groups.map((g) => `<option value="${g.id}" ${doc.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select></div>
        ${doc.groupId ? '<div class="form-row"><button class="btn ghost" id="p-copy">复制邀请码</button></div>' : ''}
        ${!state.groups.length ? '<div class="t-mut">还没有群组：登录云端后在「群组」页创建</div>' : ''}`;
      const sw = slot.querySelector('#p-share');
      const gp = slot.querySelector('#p-group');
      sw.onclick = () => { doc.isShared = !doc.isShared; sw.classList.toggle('on', doc.isShared); gp.disabled = !doc.isShared; afterChange(); };
      gp.onchange = () => { doc.groupId = gp.value; afterChange(); };
      const cp = slot.querySelector('#p-copy');
      if (cp) cp.onclick = () => {
        const g = state.groups.find((x) => x.id === doc.groupId);
        if (!g) return;
        const txt = g.inviteCode;
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => toast('邀请码已复制：' + txt), () => toast('邀请码：' + txt));
        else toast('邀请码：' + txt);
      };
    } else if (id === 'more') {
      renderBulkPanel(slot);
    }
  };
}

/* ================= 批量添加（规则 → 每日 Todo） ================= */
function renderBulkPanel(slot) {
  const cal = state.workdayCal || defaultCalendar(new Date().getFullYear());
  const wdNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  slot.innerHTML = `
    <div class="pan-lbl">批量添加（按规则写入每日 Todo）</div>
    <div class="form-row"><input class="cat-input" id="bk-text" placeholder="任务文字，如：早上吃药" /></div>
    <div class="form-row">
      <select id="bk-type" class="cat-input">
        <option value="weekly">每周重复</option>
        <option value="legal-workday">中国法定工作日</option>
        <option value="legal-holiday">中国法定节假日</option>
        <option value="date-range">指定日期范围</option>
      </select>
    </div>
    <div class="form-row" id="bk-wdrow">${[1, 2, 3, 4, 5, 6, 7].map((i) => `<span class="chip-btn" data-wd="${i}">${wdNames[i]}</span>`).join('')}</div>
    <div class="form-row" id="bk-rangerow" hidden>
      <input type="date" id="bk-start" value="${todayStr()}" />
      <input type="date" id="bk-end" value="${shiftDate(todayStr(), 30)}" />
    </div>
    <div class="form-row"><label class="t-mut"><input type="checkbox" id="bk-check" checked /> 带勾选框（参与完成统计）</label></div>
    <div class="form-row"><button class="btn primary" id="bk-run">生成到每日 Todo</button></div>
    ${cal.configured === false ? `<div class="t-mut" style="margin:6px 0">『${cal.year} 年』中国法定节假日尚未内置（以国务院当年通知为准），请在下方手动配置节假日与调休补班日。</div>` : `<div class="t-mut" style="margin:6px 0">已按中国 ${cal.year} 年日历识别节假日/调休；可在下方手动修正。</div>`}
    <div class="pan-lbl" style="margin-top:10px">法定节假日日历（本地配置，可调休）</div>
    <div class="form-row"><textarea class="cat-input" id="bk-hol" rows="2" placeholder="节假日，逗号分隔：2026-01-01,2026-01-02">${(cal.holidays || []).join(',')}</textarea></div>
    <div class="form-row"><textarea class="cat-input" id="bk-extra" rows="2" placeholder="调休上班日，逗号分隔">${(cal.extraWorkdays || []).join(',')}</textarea></div>
    <div class="form-row"><button class="btn ghost" id="bk-cal">保存日历</button></div>
    ${state.bulkRules.length ? `<div class="pan-lbl" style="margin-top:10px">已有规则</div>` + state.bulkRules.map((r) => `<div class="form-row t-mut">${esc(r.taskText)} · ${r.type === 'weekly' ? '每周' + (r.weekdays || []).map((w) => wdNames[w]).join('/') : r.type === 'legal-workday' ? '法定工作日' : esc(r.startDate || '') + '~' + esc(r.endDate || '')}<div class="spacer"></div><button class="btn ghost sm" data-bkdel="${r.id}">删除</button></div>`).join('') : ''}
    <div class="form-row" style="margin-top:10px"><a class="btn ghost" href="#/mine">主题设置 ›</a></div>`;
  const typeEl = slot.querySelector('#bk-type');
  const syncRows = () => {
    slot.querySelector('#bk-wdrow').hidden = typeEl.value !== 'weekly';
    slot.querySelector('#bk-rangerow').hidden = typeEl.value !== 'date-range';
  };
  typeEl.onchange = syncRows;
  syncRows();
  slot.querySelectorAll('[data-wd]').forEach((c) => { c.onclick = () => c.classList.toggle('on'); });
  slot.querySelector('#bk-cal').onclick = () => {
    const parse = (v) => String(v || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
    state.workdayCal = Object.assign({}, cal, { holidays: parse(slot.querySelector('#bk-hol').value), extraWorkdays: parse(slot.querySelector('#bk-extra').value), userEdited: true });
    setMeta('workdayCal', state.workdayCal);
    toast('日历已保存');
  };
  slot.querySelector('#bk-run').onclick = async () => {
    const text = slot.querySelector('#bk-text').value.trim();
    if (!text) { toast('请输入任务文字'); return; }
    const rule = {
      id: uid('r'),
      type: typeEl.value,
      taskText: text,
      weekdays: Array.from(slot.querySelectorAll('[data-wd].on')).map((c) => Number(c.dataset.wd)),
      startDate: slot.querySelector('#bk-start').value,
      endDate: slot.querySelector('#bk-end').value,
      hasCheckbox: slot.querySelector('#bk-check').checked,
      createdAt: Date.now()
    };
    if (rule.type === 'weekly' && !rule.weekdays.length) { toast('请至少选择一个星期几'); return; }
    const start = rule.type === 'date-range' ? (rule.startDate || todayStr()) : todayStr();
    const end = rule.type === 'date-range' ? (rule.endDate || todayStr()) : shiftDate(todayStr(), 30);
    const dates = datesForRule(rule, start, end, state.workdayCal);
    let added = 0, skipped = 0;
    for (const date of dates) {
      let todo = state.todos.find((t) => t.moduleType === 'daily' && t.targetDate === date);
      if (!todo) {
        todo = newTodoDoc({ moduleType: 'daily', targetDate: date, title: formatDailyTodoTitle(date), titleCustom: true, templateId: getDefaultTemplateByCategory(1), tasks: [] }, state.user);
        await TodoRepository.createTodo(todo);
        state.todos.push(todo);
      }
      if (hasTaskFromRule(todo, rule.id)) { skipped++; continue; }
      todo.tasks = normalizeTasks(todo.tasks).concat([{ id: uid('t'), text, completed: false, hasCheckbox: rule.hasCheckbox, level: 1, sourceRuleId: rule.id }]);
      todo.isDone = isTodoCompleted(todo.tasks);
      todo.updateTime = Date.now();
      todo.lastEditedBy = state.user.ownerId;
      todo.lastEditedByName = state.user.nickName;
      await TodoRepository.updateTodo(todo);
      added++;
    }
    state.bulkRules.push(rule);
    setMeta('bulkRules', state.bulkRules);
    toast(`已生成 ${added} 条任务${skipped ? '，跳过重复 ' + skipped + ' 条' : ''}`);
    renderBulkPanel(slot);
  };
  slot.querySelectorAll('[data-bkdel]').forEach((b) => {
    b.onclick = () => {
      state.bulkRules = state.bulkRules.filter((r) => r.id !== b.dataset.bkdel);
      setMeta('bulkRules', state.bulkRules);
      renderBulkPanel(slot);
    };
  });
}

/* ================= 编辑页（详情即编辑，自动保存） ================= */
async function renderEdit(idOrNew, params) {
  document.body.classList.add('editing');
  const isNew = !idOrNew || idOrNew === 'new';
  let doc;
  if (isNew) {
    const moduleType = params.get('module') === 'categorized' ? 'categorized' : 'daily';
    const catId = params.get('cat') != null ? Number(params.get('cat')) : 0;
    doc = newTodoDoc({
      moduleType,
      targetDate: moduleType === 'daily' ? (params.get('date') || todayStr()) : '',
      categoryId: moduleType === 'daily' ? 1 : catId,
      templateId: getDefaultTemplateByCategory(moduleType === 'daily' ? 1 : catId),
      tasks: [{ id: 't0', text: '', completed: false, hasCheckbox: true }]
    }, state.user);
  } else {
    doc = await TodoRepository.getTodoById(idOrNew);
    if (!doc) { toast('To Do 不存在或已删除'); location.hash = '#/daily'; return; }
    doc.tasks = normalizeTasks(doc.tasks);
  }

  const saveStateEl = () => document.getElementById('save-state');
  view.innerHTML = `
    <div class="edit-head">
      <button class="icon-btn" id="e-back">‹</button>
      <div>
        <div style="font-weight:700">${isNew ? '新建 To Do' : 'To Do'}</div>
        <div class="save-state" id="save-state">${isNew ? '未保存' : '创建 ' + esc(fmtMinute(doc.createTime)) + ' · 修改 ' + esc(fmtMinute(doc.updateTime))}</div>
      </div>
      <div class="spacer"></div>
      <button class="btn" id="e-save">${isNew ? '保存' : '保存'}</button>
    </div>
    <div class="edit-layout">
      <div class="edit-main"><div id="pe-mount"></div>
        <div class="card todo-bottom-actions" id="e-bottom">
          <button class="btn" data-bpan="tpl">模板</button>
          <button class="btn" data-bpan="share">共享</button>
          <button class="btn" data-bpan="more">更多</button>
          ${!isNew ? '<button class="btn" data-pin="1">置顶</button>' : ''}
        </div>
        <div class="tool-pan pan-slot" id="e-bslot" hidden></div>
      </div>
      <aside class="edit-side" id="e-side">
        <div class="card">
          <div class="row" style="margin-bottom:8px"><b>设置</b></div>
          <div class="form-row">
            <span class="lbl">模块</span>
            <div class="seg-select" id="e-module">
              <span class="seg ${doc.moduleType === 'daily' ? 'active' : ''}" data-m="daily">每日 Todo</span>
              <span class="seg ${doc.moduleType === 'categorized' ? 'active' : ''}" data-m="categorized">分类专题</span>
            </div>
          </div>
          <div class="form-row" id="e-daterow" style="${doc.moduleType === 'daily' ? '' : 'display:none'}">
            <span class="lbl">归属日</span>
            <input type="date" id="e-date" value="${esc(doc.targetDate || todayStr())}" />
          </div>
          <div class="form-row" id="e-catrow" style="${doc.moduleType === 'categorized' ? '' : 'display:none'}">
            <span class="lbl">类别</span>
            <select id="e-cat">
              ${categoryOptions(state.user.customCategories).map((o) => `<option value="${o.id}" ${doc.categoryId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
            </select>
            <span class="t-mut">专题不填开始/结束日，只自动记录创建与修改时间</span>
          </div>
          ${!isNew ? `<div class="form-row"><button class="btn ghost" id="e-pin">${doc.isPinned ? '取消置顶' : '置顶（专题缩小版顶部）'}</button></div>` : ''}
          <div class="form-row">
            <span class="t-mut">创建 ${esc(fmtMinute(doc.createTime))} · 最近修改 ${esc(fmtMinute(doc.updateTime))}${doc.lastEditedByName ? ' · 最近由 ' + esc(doc.lastEditedByName) : ''}</span>
          </div>
          ${!isNew ? '<div class="form-row"><button class="btn danger" id="e-del">删除这条 To Do</button></div>' : ''}
        </div>
      </aside>
    </div>`;

  state.edit = { doc, isNew, editor: null, saveTimer: null, dirty: false };
  // v2.3：模板/共享改由编辑工具面板维护（与编辑工具同级）
  const cur = { templateId: doc.templateId || 'plain-paper', isShared: !!doc.isShared, groupId: doc.groupId || '' };


  function wrapPageClass() {
    /* 编辑页模板由纸张自身承载；整页覆盖只作用于今日/专题放大版容器 */
    const main = document.querySelector('.edit-main');
    if (main) main.className = 'edit-main';
  }

  const editor = createPaperEditor({
    mount: document.getElementById('pe-mount'),
    initial: { title: isNew ? '' : (doc.titleCustom ? (doc.title || '') : ''), titleStyle: doc.titleStyle, tasks: doc.tasks },
    paperClass: paperClassOf(doc.templateId),
    onChange: () => { state.edit.dirty = true; scheduleAutoSave(); }
  });
  state.edit.editor = editor;
  wrapPageClass();
  bindBottomActions('e-bottom', 'e-bslot',
    makePanelOpener(() => state.edit.editor, () => cur, () => { state.edit.dirty = true; scheduleAutoSave(); }));
  const bpin = document.querySelector('#e-bottom [data-pin]');
  if (bpin) bpin.onclick = () => { const p = document.getElementById('e-pin'); if (p) p.onclick(); };

  // 桌面端把「编辑工具」模块移到右侧栏（移动端保持在纸张下方）
  const toolsEl = document.getElementById('pe-tools');
  const sideEl = document.getElementById('e-side');
  function placeTools() {
    if (window.innerWidth >= 860) sideEl.insertBefore(toolsEl, sideEl.firstChild);
    else document.getElementById('pe-mount').appendChild(toolsEl);
  }
  placeTools();
  window.addEventListener('resize', placeTools);
  state.edit.cleanupResize = () => window.removeEventListener('resize', placeTools);

  const pinBtn = document.getElementById('e-pin');
  if (pinBtn) pinBtn.onclick = async () => {
    doc.isPinned = !doc.isPinned;
    doc.pinnedAt = doc.isPinned ? new Date().toISOString() : '';
    state.edit.dirty = true;
    await saveNow('silent');
    pinBtn.textContent = doc.isPinned ? '取消置顶' : '置顶（专题缩小版顶部）';
    toast(doc.isPinned ? '已置顶' : '已取消置顶');
  };

  function collectSettings() {
    const moduleType = document.querySelector('#e-module .seg.active').dataset.m;
    const targetDate = moduleType === 'daily' ? (document.getElementById('e-date').value || todayStr()) : '';
    const categoryId = moduleType === 'daily' ? 1 : Number(document.getElementById('e-cat').value || 0);
    const categoryName = moduleType === 'daily' ? PRESET_CATEGORIES[1]
      : (categoryOptions(state.user.customCategories).find((o) => o.id === categoryId) || { name: '未分类' }).name;
    return { moduleType, targetDate, categoryId, categoryName,
      templateId: cur.templateId, isShared: cur.isShared && !!cur.groupId ? true : !!cur.groupId, groupId: cur.groupId };
  }

  function buildDoc() {
    const payload = editor.getPayload();
    const s = collectSettings();
    const m = templateMeta(s.templateId);
    const title = payload.title;
    return Object.assign({}, state.edit.doc, {
      title: title,
      titleCustom: !!title,
      titleStyle: payload.titleStyle,
      tasks: payload.tasks,
      moduleType: s.moduleType,
      targetDate: s.targetDate,
      categoryId: s.categoryId,
      categoryName: s.categoryName,
      templateId: s.templateId,
      isShared: s.isShared && !!s.groupId ? s.isShared : !!s.groupId,
      groupId: s.groupId,
      isDone: isTodoCompleted(payload.tasks),
      lastEditedBy: state.user.ownerId,
      lastEditedByName: state.user.nickName,
      updateTime: Date.now()
    });
  }

  async function saveNow(showTips) {
    if (!state.edit) return;
    const next = buildDoc();
    if (state.edit.isNew) {
      await TodoRepository.createTodo(next);
      queueSync();
      state.edit.isNew = false;
      state.edit.doc = next;
      state.todos.push(next);
      if (showTips !== 'silent') toast('已保存');
      // 切到「已有」地址（避免刷新丢失），用 replaceState 不触发重渲染
      history.replaceState(null, '', '#/edit/' + next.id);
      if (saveStateEl()) saveStateEl().textContent = '已保存 ' + fmtMinute(next.updateTime);
    } else {
      await TodoRepository.updateTodo(next);
      queueSync();
      state.edit.doc = next;
      const i = state.todos.findIndex((t) => t.id === next.id);
      if (i >= 0) state.todos[i] = next;
      if (showTips === true) toast('已保存');
      if (saveStateEl()) saveStateEl().textContent = '已保存 ' + fmtMinute(next.updateTime);
    }
    state.edit.dirty = false;
  }

  function scheduleAutoSave() {
    clearTimeout(state.edit.saveTimer);
    if (saveStateEl()) saveStateEl().textContent = '编辑中…';
    state.edit.saveTimer = setTimeout(() => saveNow(), 700);
  }
  function flushEditSaveLocal() {
    if (state.edit && state.edit.dirty) { clearTimeout(state.edit.saveTimer); saveNow('silent'); }
  }
  window.__flushEditSave = flushEditSaveLocal;

  // 事件
  document.getElementById('e-back').onclick = () => { flushEditSaveLocal(); history.length > 1 ? history.back() : (location.hash = '#/daily'); };
  document.getElementById('e-save').onclick = () => saveNow(true);
  document.getElementById('e-module').onclick = (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    document.querySelectorAll('#e-module .seg').forEach((s) => s.classList.toggle('active', s === seg));
    const daily = seg.dataset.m === 'daily';
    document.getElementById('e-daterow').style.display = daily ? '' : 'none';
    document.getElementById('e-catrow').style.display = daily ? 'none' : '';
    if (!daily && doc.categoryId === 1) {
      // 从每日切到专题时默认回到「未分类」，可再选
      document.getElementById('e-cat').value = '0';
    }
    state.edit.dirty = true;
    scheduleAutoSave();
  };
  document.getElementById('e-date').onchange = () => { state.edit.dirty = true; scheduleAutoSave(); };
  document.getElementById('e-cat').onchange = () => { state.edit.dirty = true; scheduleAutoSave(); };
  document.getElementById('e-tpl').onclick = (e) => {
    const item = e.target.closest('.tpl-item');
    if (!item) return;
    document.querySelectorAll('#e-tpl .tpl-item').forEach((t) => t.classList.toggle('active', t === item));
    editor.setPaperAppearance(paperClassOf(item.dataset.id));
    state.edit.dirty = true;
    scheduleAutoSave();
  };
  document.getElementById('e-share').onclick = () => {
    const sw = document.getElementById('e-share');
    sw.classList.toggle('on');
    document.getElementById('e-group').disabled = !sw.classList.contains('on');
    if (sw.classList.contains('on') && !state.groups.length) {
      toast('还没有群组，请先到「群组」页创建');
      sw.classList.remove('on');
      document.getElementById('e-group').disabled = true;
      return;
    }
    state.edit.dirty = true;
    scheduleAutoSave();
  };
  document.getElementById('e-group').onchange = () => { state.edit.dirty = true; scheduleAutoSave(); };
  const delBtn = document.getElementById('e-del');
  if (delBtn) delBtn.onclick = async () => {
    if (!window.confirm('确认删除这条 To Do？')) return;
    state.edit.dirty = false;
    await TodoRepository.deleteTodo(state.edit.doc.id);
    toast('已删除');
    location.hash = '#/daily';
  };
}

function flushEditSave() {
  if (window.__flushEditSave) window.__flushEditSave();
  if (state.edit && state.edit.cleanupResize) state.edit.cleanupResize();
}
window.addEventListener('beforeunload', () => { flushEditSave(); flushDailySave(); flushCateSave(); cleanupDailyDraft(); });

/* ================= 群组（本地演示，字段与小程序一致） ================= */
function renderGroups() {
  document.body.classList.remove('editing');
  destroyCateEditor();
  const cloud = USE_SUPABASE && supaState().active;
  view.innerHTML = `
    <div class="hint-card">${cloud
      ? '群组已接入云端：创建 / 加入 / 删除跨设备生效；把 To Do 共享给群组后，成员可见并协同编辑任务内容。'
      : (USE_SUPABASE
        ? '当前未登录云端：登录后群组可跨设备创建与加入；未登录时邀请码仅在本机浏览器有效。'
        : '网页端群组数据保存在本机浏览器（IndexedDB）；跨设备共享请在微信小程序端使用。')}</div>
    <div class="card">
      <div class="row">
        <input class="cat-input" id="g-name" placeholder="新群组名称" style="flex:1" />
        <button class="btn" id="g-create">创建群组</button>
      </div>
      <div class="row" style="margin-top:10px">
        <input class="cat-input" id="g-code" placeholder="输入邀请码加入" style="flex:1" />
        <button class="btn ghost" id="g-join">加入</button>
      </div>
    </div>
    <div id="g-list">
      ${state.groups.length ? state.groups.map((g) => `
        <div class="card group-item" data-id="${g.id}">
          <div>
            <div style="font-weight:700">${esc(g.name)}${g.ownerId === state.user.ownerId ? ' <span class="badge share">我创建的</span>' : ''}</div>
            <div class="t-mut" style="margin-top:4px">邀请码 <span class="code">${esc(g.inviteCode)}</span> · 创建 ${esc(fmtMinute(g.createTime))}</div>
          </div>
          ${g.ownerId === state.user.ownerId ? `<button class="btn danger" data-del="${g.id}">删除</button>` : ''}
        </div>`).join('') : '<div class="empty">还没有群组</div>'}
    </div>`;

  document.getElementById('g-create').onclick = async () => {
    const name = document.getElementById('g-name').value.trim();
    if (!name) { toast('请输入群组名称'); return; }
    try {
      const { inviteCode } = await import('./util.js');
      const g = { id: 'g-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, inviteCode: inviteCode(), createTime: Date.now(), ownerId: state.user.ownerId };
      await GroupRepository.createGroup(g);
      toast('已创建群组，邀请码 ' + g.inviteCode);
      await reloadAll();
      renderGroups();
    } catch (e) { toast('创建失败：' + (e.message || e)); }
  };
  document.getElementById('g-join').onclick = async () => {
    const code = document.getElementById('g-code').value.trim();
    if (!code) { toast('请输入邀请码'); return; }
    try {
      const msg = await GroupRepository.joinByCode(code);
      toast(msg);
      await reloadAll();
      renderGroups();
    } catch (e) { toast(e.message || '加入失败：网络异常，请稍后重试'); }
  };
  document.getElementById('g-list').onclick = async (e) => {
    const id = e.target.dataset && e.target.dataset.del;
    if (!id) return;
    if (!window.confirm('删除这个群组？（不会删除已共享的 To Do，但其共享状态需重新选择群组）')) return;
    try {
      await GroupRepository.deleteGroup(id);
      await reloadAll();
      renderGroups();
    } catch (err) { toast(err.message || '删除失败'); }
  };
}

/* ================= 我的 ================= */
function renderMine() {
  document.body.classList.remove('editing');
  const supa = supaState();
  const total = state.todos.length;
  const doneCnt = state.todos.filter((t) => t.isDone).length;
  const stat = state.todos.reduce((acc, t) => {
    const s = tasksStat(t.tasks);
    acc.total += s.total; acc.done += s.done;
    return acc;
  }, { total: 0, done: 0 });
  view.innerHTML = `
    <div class="card">
      <div class="stat-grid">
        <div><div class="num">${total}</div><div class="t-mut">To Do 总数</div></div>
        <div><div class="num">${doneCnt}</div><div class="t-mut">整篇已完成</div></div>
        <div><div class="num">${stat.done}/${stat.total}</div><div class="t-mut">勾选框任务</div></div>
      </div>
    </div>

    ${USE_SUPABASE ? `
    <div class="card">
      <div class="row" style="margin-bottom:8px"><b>账号与云同步（Supabase）</b></div>
      ${supa.active ? `
      <div class="t-mut">已登录：${esc(supa.email)}</div>
      <div class="row" style="flex-wrap:wrap;margin-top:8px">
        <button class="btn primary" id="m-upcloud">上传本机数据到云端</button>
        <button class="btn ghost" id="m-signout">退出登录</button>
      </div>
      <div class="t-mut" style="margin-top:8px">已登录且在线时，To Do 读写云端（多设备同步）；离线或未登录时回落本机存储。</div>` : `
      <div class="t-mut" style="line-height:1.8">输入邮箱 → 点「发送验证邮件」→ 两种方式任选其一完成登录（无密码）：① 点击邮件里的登录链接；② 链接打不开时（国内网络常见），把邮件里的 <b>6 位验证码</b> 填到下面登录。登录后 To Do 存云端，可在多台设备同步；首次登录后建议点「上传本机数据到云端」完成迁移。</div>
      <div class="form-row"><input class="cat-input" id="m-email" type="email" placeholder="you@example.com" /></div>
      <div class="form-row"><button class="btn primary" id="m-login">发送验证邮件</button></div>
      <div class="form-row"><input class="cat-input" id="m-code" placeholder="邮件里的 6 位验证码" maxlength="6" inputmode="numeric" style="flex:1" /><button class="btn ghost" id="m-verify">验证码登录/验证</button></div>
      <div class="form-row"><button class="btn ghost" id="m-resend">重新发送验证邮件</button></div>
      <div class="t-mut">链接在国内打不开时：在邮件里长按/右键复制那条链接，取其中 <b>token=</b> 后面的 6 位数字填入验证码框；或点「重新发送验证邮件」获取新验证码（旧验证码自动失效）。</div>
      <div class="row" style="margin-top:6px"><b style="font-size:12px">推荐：密码登录 / 注册（不走邮件，国内网络最稳）</b></div>
      <div class="form-row"><input class="cat-input" id="m-pass" type="password" placeholder="设置密码（≥6 位，注册与登录同密码）" style="flex:1" /><button class="btn primary" id="m-pw">密码登录/注册</button></div>
      <div class="t-mut">已有账号=直接登录；没注册过=自动注册并登录（已开自动确认，无需点邮件）。</div>`}
    </div>
    ` : ''}
    <div class="card">
      <div class="row" style="margin-bottom:8px"><b>主题（温柔治愈 · 莫兰迪）</b></div>
      <div class="row" style="flex-wrap:wrap">
        ${THEMES.map((t) => `<button class="chip-btn ${state.theme.themeId === t.id ? 'on' : ''}" data-theme-id="${t.id}">${t.name}</button>`).join('')}
      </div>
      <div class="row" style="flex-wrap:wrap;margin-top:8px">
        ${THEME_BGS.map((b) => `<button class="chip-btn ${state.theme.bgId === b.id ? 'on' : ''}" data-bg-id="${b.id}">${b.name}</button>`).join('')}
      </div>
      <div class="t-mut" style="margin-top:8px">主题与背景全局生效（含今日/专题/详情/编辑工具/进度条），仅显示名称、不显示预览图。</div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:8px"><b>像 App 一样使用</b></div>
      <div class="t-mut" style="line-height:1.8">
        点击浏览器菜单，选择「添加到主屏幕 / 安装应用」，即可像 App 一样使用（Android Chrome 与 iOS Safari 均支持）。<br />
        <button class="btn" id="m-install" style="margin-top:8px">安装到桌面</button>
      </div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:8px"><b>自定义分类（专题模块 6-10）</b></div>
      ${[0, 1, 2, 3, 4].map((i) => `
        <div class="form-row">
          <span class="lbl">槽位 ${6 + i}</span>
          <input class="cat-input" data-cati="${i}" value="${esc(state.user.customCategories[i] || '')}" placeholder="自定义分类名称" maxlength="8" />
        </div>`).join('')}
      <div class="form-row"><button class="btn ghost" id="m-catsave">保存分类</button></div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:8px"><b>数据</b></div>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn ghost" id="m-export">导出 JSON</button>
        <button class="btn ghost" id="m-import">导入 JSON</button>
        <input type="file" id="m-file" accept="application/json" style="display:none" />
        <div class="spacer"></div>
        <button class="btn danger" id="m-wipe">清空本机数据</button>
      </div>
      <div class="t-mut" style="margin-top:8px">数据保存在本机浏览器（IndexedDB），离线可用；网页版 v1.0 · 与小程序数据模型一致</div>
    </div>`;

  document.getElementById('m-install').onclick = () => {
    if (window.__deferredPrompt) {
      window.__deferredPrompt.prompt();
      window.__deferredPrompt.userChoice.then(() => { window.__deferredPrompt = null; });
    } else {
      toast('请用浏览器菜单「添加到主屏幕」安装');
    }
  };
  const mLoginBtn = document.getElementById('m-login');
  if (mLoginBtn) mLoginBtn.onclick = async () => {
    const email = (document.getElementById('m-email').value || '').trim();
    if (!email || !email.includes('@')) { toast('请输入有效的邮箱地址'); return; }
    mLoginBtn.disabled = true;
    try { await signInWithEmail(email); toast('登录链接已发送，请到邮箱点击链接完成登录'); }
    catch (e) { toast('发送失败：' + (e.message || e)); }
    mLoginBtn.disabled = false;
  };
  const mResendBtn = document.getElementById('m-resend');
  if (mResendBtn) mResendBtn.onclick = async () => {
    const email = (document.getElementById('m-email').value || '').trim();
    if (!email || !email.includes('@')) { toast('请先填写邮箱地址'); return; }
    console.log('[Auth] resend verification email:', email);
    try { await signInWithEmail(email); toast('已重新发送：取邮件链接中 token= 后的 6 位数字即可验证'); }
    catch (e) { toast('发送失败：' + (e.message || e)); }
  };
  const mVerifyBtn = document.getElementById('m-verify');
  if (mVerifyBtn) mVerifyBtn.onclick = async () => {
    const email = (document.getElementById('m-email').value || '').trim();
    const code = (document.getElementById('m-code').value || '').trim();
    if (!email || !code) { toast('请先填邮箱和 6 位验证码'); return; }
    mVerifyBtn.disabled = true;
    try {
      await verifyWithCode(email, code);
      toast('登录成功，正在切换云端数据…');
    } catch (e) {
      console.error('[Auth] verify failed:', e);
      toast(e.message || '验证失败，请重发验证码');
    }
    mVerifyBtn.disabled = false;
  };
  const mPwBtn = document.getElementById('m-pw');
  if (mPwBtn) mPwBtn.onclick = async () => {
    const email = (document.getElementById('m-email').value || '').trim();
    const pw = document.getElementById('m-pass').value || '';
    if (!email || !email.includes('@')) { toast('请先填写邮箱地址'); return; }
    if (pw.length < 6) { toast('密码至少 6 位'); return; }
    mPwBtn.disabled = true;
    mPwBtn.textContent = '登录中…';
    try {
      await signInWithPasswordOrSignup(email, pw);
      toast('登录成功，正在切换云端数据…');
    } catch (e) {
      const msg = e.message || '登录失败';
      toast(msg);
      if (/注册|验证/.test(msg)) {
        const codeEl = document.getElementById('m-code');
        if (codeEl) codeEl.focus();
      }
    }
    mPwBtn.disabled = false;
    mPwBtn.textContent = '密码登录/注册';
  };
  const mUpBtn = document.getElementById('m-upcloud');
  if (mUpBtn) mUpBtn.onclick = async () => {
    mUpBtn.disabled = true;
    try { await tryCloudSync(); toast(window.__cloudOk ? '已同步到云端' : '云端暂连不上，稍后自动重试'); render(); }
    catch (e) { toast('同步失败：' + (e.message || e)); mUpBtn.disabled = false; }
  };
  view.querySelectorAll('[data-theme-id]').forEach((b) => {
    b.onclick = () => {
      state.theme.themeId = b.dataset.themeId;
      setMeta('theme', state.theme);
      applyTheme();
      view.querySelectorAll('[data-theme-id]').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  view.querySelectorAll('[data-bg-id]').forEach((b) => {
    b.onclick = () => {
      state.theme.bgId = b.dataset.bgId;
      setMeta('theme', state.theme);
      applyTheme();
      view.querySelectorAll('[data-bg-id]').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  const mOutBtn = document.getElementById('m-signout');
  if (mOutBtn) mOutBtn.onclick = async () => {
    if (!window.confirm('退出登录？云端数据保留，本机回到离线存储模式。')) return;
    try { await signOutCloud(); toast('已退出登录'); } catch (e) { /* 网络异常忽略 */ }
    render();
  };
  document.getElementById('m-catsave').onclick = async () => {
    const cats = ['', '', '', '', ''];
    document.querySelectorAll('[data-cati]').forEach((inp) => { cats[Number(inp.dataset.cati)] = inp.value.trim(); });
    state.user.customCategories = cats;
    await saveLocalUser(state.user);
    toast('已保存自定义分类');
  };
  document.getElementById('m-export').onclick = async () => {
    const data = await exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `一起todo-backup-${tsToDateStr(Date.now())}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  document.getElementById('m-import').onclick = () => document.getElementById('m-file').click();
  document.getElementById('m-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const n = await importAll(data, 'merge');
      toast(`已导入 ${n} 条 To Do`);
      render();
    } catch (err) {
      toast('导入失败：' + err.message);
    }
    e.target.value = '';
  };
  document.getElementById('m-wipe').onclick = async () => {
    if (!window.confirm('清空本机全部 To Do 与群组数据？建议先「导出 JSON」备份。')) return;
    await Promise.all(state.todos.map((t) => TodoRepository.deleteTodo(t.id)));
    await Promise.all(state.groups.map((g) => GroupRepository.deleteGroup(g.id)));
    toast('已清空');
    render();
  };
}

/* ================= PWA / 全局 ================= */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__deferredPrompt = e;
});
function syncOffline() { offlineEl.classList.toggle('hide', navigator.onLine); }
window.addEventListener('online', syncOffline);
window.addEventListener('offline', syncOffline);
syncOffline();

const SW_ENABLED = false; // v2.4.1 排障期临时关闭 SW：保证所有设备立刻拿最新代码；稳定后改回 true
if (SW_ENABLED && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 部分环境（如 file://）不支持 */ });
  });
}

/* v2.2.1：首渲染立即执行、不被 SDK 加载阻塞；登录会话后台恢复，完成后自动整页刷新 */
loadPrefs().then(() => {
  const h = location.hash || '';
  if (h.indexOf('#error=') === 0) {
    const p = new URLSearchParams(h.slice(7));
    const desc = p.get('error_description') || p.get('error_code') || '验证失败';
    console.error('[Auth] redirect error:', h);
    setTimeout(() => toast('邮箱验证未通过：' + decodeURIComponent(desc.replace(/\+/g, ' ')) + '。请改用「重新发送验证邮件 + 6 位验证码」登录'), 600);
    history.replaceState(null, '', location.pathname + location.search + '#/mine');
  }
  render();
});
initAuth(() => { setBadge('sync'); queueSync(); render(); })
  .then(() => { if (supaState().active) render(); })
  .catch(() => { /* SDK 加载失败：保持本地模式，登录按钮会提示重试 */ });
