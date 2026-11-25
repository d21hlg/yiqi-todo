/* app.js —— 网页版路由与视图（今日 / 专题 / 编辑 / 群组 / 我的）
 * 功能规则与微信小程序端一致：单日聚焦、专题筛选（月/日/类别/关键词/重置）、
 * 整篇标题、checkbox 可选、首页卡片只显示标题+进度、模板、分类、共享字段、群组。
 */
import {
  PRESET_CATEGORIES, TODO_TEMPLATES, templateMeta, getDefaultTemplateByCategory, categoryOptions,
  getTodoTitlePreview, getTodoDate, filterTodos, tasksStat, isTodoCompleted, normalizeTasks,
  todayStr, shiftDate, dayInfo, fmtMinute, daysInMonth, tsToDateStr, esc, debounce
} from './util.js';
import { TodoRepository, GroupRepository, getLocalUser, saveLocalUser, newTodoDoc, exportAll, importAll } from './db.js';
import { createPaperEditor } from './paper.js';

const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
const toastEl = document.getElementById('toast');
const offlineEl = document.getElementById('offline');

const state = {
  user: null,
  todos: [],
  groups: [],
  daily: { date: todayStr(), filter: 'all' },
  filters: { selectedMonth: '', selectedDay: '', selectedCategoryId: null, keyword: '' },
  edit: null // { doc, isNew, editor, saveTimer, dirty }
};

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hide');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hide'), 1800);
}
window.__toast = toast;

async function reloadAll() {
  const [todos, groups, user] = await Promise.all([
    TodoRepository.getTodos(), GroupRepository.getGroups(), getLocalUser()
  ]);
  state.todos = todos;
  state.groups = groups;
  state.user = user;
}

/* ================= 路由 ================= */
function parseHash() {
  const h = (location.hash || '#/daily').replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const parts = path.split('/').filter(Boolean); // ['edit','id']
  const params = new URLSearchParams(query || '');
  return { parts, params };
}

async function render() {
  flushEditSave();
  if (state.edit && state.edit.editor) { state.edit.editor.destroy(); state.edit.editor = null; }
  state.edit = null;
  await reloadAll();

  const { parts, params } = parseHash();
  const route = parts[0] || 'daily';
  document.querySelectorAll('#tabbar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === route);
  });

  if (route === 'daily') renderDaily();
  else if (route === 'cate') renderCate();
  else if (route === 'groups') renderGroups();
  else if (route === 'mine') renderMine();
  else if (route === 'edit') await renderEdit(parts[1], params);
  else renderDaily();

  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

/* ================= 通用：Todo 卡片 ================= */
function todoCardHtml(todo) {
  const st = tasksStat(todo.tasks);
  const badges = [];
  if (todo.isShared) badges.push('<span class="badge share">共享</span>');
  if (todo.isDone) badges.push('<span class="badge done">已完成</span>');
  const cat = todo.moduleType === 'categorized' && todo.categoryId ? `<span>${esc(todo.categoryName || '')}</span>` : '';
  return `<div class="card todo-card" data-id="${todo.id}">
    <div class="title">${esc(getTodoTitlePreview(todo, 24))}</div>
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

/* ================= 今日（单日聚焦） ================= */
function renderDaily() {
  const d = state.daily.date;
  const info = dayInfo(d);
  const dayTodos = state.todos
    .filter((t) => t.moduleType === 'daily' && t.targetDate === d)
    .sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0));
  const shown = dayTodos.filter((t) => state.daily.filter === 'all'
    || (state.daily.filter === 'undone' ? !t.isDone : t.isDone));
  const allStat = dayTodos.reduce((acc, t) => {
    const s = tasksStat(t.tasks);
    acc.total += s.total; acc.done += s.done;
    return acc;
  }, { total: 0, done: 0 });
  const pct = allStat.total ? Math.round((allStat.done / allStat.total) * 100) : 0;
  document.body.classList.remove('editing');

  view.innerHTML = `
    <div class="date-head">
      <button class="arrow-btn" id="d-prev">‹</button>
      <div>
        <div class="big-date">${esc(info.label)}</div>
        <div class="sub">${esc(d)} ${esc(info.week)}</div>
      </div>
      <button class="arrow-btn" id="d-next">›</button>
      <input type="date" id="d-pick" value="${d}" />
      <button class="arrow-btn" id="d-today">回到今天</button>
      <div class="spacer"></div>
      <button class="btn" id="d-new">＋ 新建</button>
    </div>

    <div class="card progress-card">
      <div class="row">
        <span class="pct">${pct}%</span>
        <div class="spacer"></div>
        <span>${allStat.done} / ${allStat.total} 项带勾选框任务</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>

    <div class="chips" id="d-chips">
      <span class="chip ${state.daily.filter === 'all' ? 'active' : ''}" data-f="all">全部 ${dayTodos.length}</span>
      <span class="chip ${state.daily.filter === 'undone' ? 'active' : ''}" data-f="undone">未完成</span>
      <span class="chip ${state.daily.filter === 'done' ? 'active' : ''}" data-f="done">已完成</span>
    </div>

    <div id="d-list">
      ${shown.length ? shown.map(todoCardHtml).join('') : '<div class="empty">这一天还没有 Todo，点右上角「＋ 新建」开始</div>'}
    </div>`;

  document.getElementById('d-prev').onclick = () => { state.daily.date = shiftDate(d, -1); renderDaily(); };
  document.getElementById('d-next').onclick = () => { state.daily.date = shiftDate(d, 1); renderDaily(); };
  document.getElementById('d-today').onclick = () => { state.daily.date = todayStr(); renderDaily(); };
  document.getElementById('d-pick').onchange = (e) => { if (e.target.value) { state.daily.date = e.target.value; renderDaily(); } };
  document.getElementById('d-new').onclick = () => { location.hash = `#/edit/new?module=daily&date=${d}`; };
  document.getElementById('d-chips').onclick = (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    state.daily.filter = c.dataset.f;
    renderDaily();
  };
  bindCards(document.getElementById('d-list'));
}

/* ================= 专题（分类 + 筛选查找） ================= */
function renderCate() {
  document.body.classList.remove('editing');
  const opts = categoryOptions(state.user.customCategories);
  const f = state.filters;
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
        <button class="btn" id="f-new">＋ 新建</button>
      </div>
    </div>
    <div id="c-list"></div>`;

  const monthEl = document.getElementById('f-month');
  const dayEl = document.getElementById('f-day');
  const catEl = document.getElementById('f-cat');
  const kwEl = document.getElementById('f-kw');

  function updateList() {
    const month = monthEl.value;
    const day = dayEl.value;
    const selectedDate = month && day ? `${month}-${day}` : '';
    const catId = catEl.value === '' ? null : Number(catEl.value);
    const list = filterTodos(
      state.todos.filter((t) => t.moduleType === 'categorized'),
      { selectedMonth: month, selectedDate, selectedCategoryId: catId, keyword: kwEl.value }
    ).sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0));
    document.getElementById('c-list').innerHTML = list.length
      ? list.map(todoCardHtml).join('')
      : '<div class="empty">没有符合条件的专题 Todo（专题不记录开始/结束日，只按创建与修改时间管理）</div>';
  }

  monthEl.onchange = () => {
    state.filters.selectedMonth = monthEl.value;
    // 月份变化时重建「日」下拉
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
  document.getElementById('f-new').onclick = () => { location.hash = '#/edit/new?module=categorized'; };
  bindCards(document.getElementById('c-list'));
  updateList();
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
      <div class="edit-main"><div id="pe-mount"></div></div>
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
          <div class="form-row">
            <span class="lbl">模板</span>
            <div class="tpl-grid" id="e-tpl">
              ${TODO_TEMPLATES.map((t) => `<div class="tpl-item ${doc.templateId === t.id ? 'active' : ''}" data-id="${t.id}"><div class="mini-paper paper ${t.cls} ps-${t.paper}" style="padding:0"></div>${esc(t.name)}</div>`).join('')}
            </div>
          </div>
          <div class="form-row">
            <span class="lbl">共享</span>
            <div class="switch ${doc.isShared ? 'on' : ''}" id="e-share"></div>
            <select id="e-group" ${doc.isShared ? '' : 'disabled'}>
              <option value="">选择群组…</option>
              ${state.groups.map((g) => `<option value="${g.id}" ${doc.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
            </select>
          </div>
          ${!state.groups.length ? '<div class="t-mut">还没有群组，去「群组」页创建一个（网页端群组为本地演示，跨端共享请在小程序内完成）</div>' : ''}
          <div class="form-row">
            <span class="t-mut">创建 ${esc(fmtMinute(doc.createTime))} · 最近修改 ${esc(fmtMinute(doc.updateTime))}${doc.lastEditedByName ? ' · 最近由 ' + esc(doc.lastEditedByName) : ''}</span>
          </div>
          ${!isNew ? '<div class="form-row"><button class="btn danger" id="e-del">删除这条 To Do</button></div>' : ''}
        </div>
      </aside>
    </div>`;

  state.edit = { doc, isNew, editor: null, saveTimer: null, dirty: false };

  const paperClassOf = (tplId) => {
    const m = templateMeta(tplId);
    return (m.cls ? m.cls + ' ' : '') + (m.paper && m.paper !== 'plain' ? 'ps-' + m.paper : '');
  };

  const editor = createPaperEditor({
    mount: document.getElementById('pe-mount'),
    initial: { title: isNew ? '' : (doc.titleCustom ? (doc.title || '') : ''), titleStyle: doc.titleStyle, tasks: doc.tasks },
    paperClass: paperClassOf(doc.templateId),
    onChange: () => { state.edit.dirty = true; scheduleAutoSave(); }
  });
  state.edit.editor = editor;

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

  function collectSettings() {
    const moduleType = document.querySelector('#e-module .seg.active').dataset.m;
    const targetDate = moduleType === 'daily' ? (document.getElementById('e-date').value || todayStr()) : '';
    const categoryId = moduleType === 'daily' ? 1 : Number(document.getElementById('e-cat').value || 0);
    const categoryName = moduleType === 'daily' ? PRESET_CATEGORIES[1]
      : (categoryOptions(state.user.customCategories).find((o) => o.id === categoryId) || { name: '未分类' }).name;
    const tplId = (document.querySelector('#e-tpl .tpl-item.active') || {}).dataset;
    const templateId = tplId ? tplId.id : doc.templateId;
    const isShared = document.getElementById('e-share').classList.contains('on');
    const groupId = isShared ? document.getElementById('e-group').value : '';
    return { moduleType, targetDate, categoryId, categoryName, templateId, isShared, groupId };
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
      state.edit.isNew = false;
      state.edit.doc = next;
      state.todos.push(next);
      if (showTips !== 'silent') toast('已保存');
      // 切到「已有」地址（避免刷新丢失），用 replaceState 不触发重渲染
      history.replaceState(null, '', '#/edit/' + next.id);
      if (saveStateEl()) saveStateEl().textContent = '已保存 ' + fmtMinute(next.updateTime);
    } else {
      await TodoRepository.updateTodo(next);
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
window.addEventListener('beforeunload', flushEditSave);

/* ================= 群组（本地演示，字段与小程序一致） ================= */
function renderGroups() {
  document.body.classList.remove('editing');
  view.innerHTML = `
    <div class="hint-card">网页端群组数据保存在本机浏览器（IndexedDB），用于共享开关与字段联调；跨设备真实群组成员与协同请在微信小程序端使用（两端字段 isShared / groupId / ownerId / lastEditedBy 完全一致）。</div>
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
            <div style="font-weight:700">${esc(g.name)}</div>
            <div class="t-mut" style="margin-top:4px">邀请码 <span class="code">${esc(g.inviteCode)}</span> · 创建 ${esc(fmtMinute(g.createTime))}</div>
          </div>
          <button class="btn danger" data-del="${g.id}">删除</button>
        </div>`).join('') : '<div class="empty">还没有群组</div>'}
    </div>`;

  document.getElementById('g-create').onclick = async () => {
    const name = document.getElementById('g-name').value.trim();
    if (!name) { toast('请输入群组名称'); return; }
    const { inviteCode } = await import('./util.js');
    const g = { id: 'g-' + Date.now().toString(36), name, inviteCode: inviteCode(), createTime: Date.now(), ownerId: state.user.ownerId };
    await GroupRepository.createGroup(g);
    toast('已创建群组');
    renderGroups();
  };
  document.getElementById('g-join').onclick = async () => {
    const code = document.getElementById('g-code').value.trim();
    if (!code) return;
    const g = await GroupRepository.findByCode(code);
    if (g) toast(`已找到「${g.name}」（本地演示，真实加入请在小程序内完成）`);
    else toast('未找到该邀请码');
  };
  document.getElementById('g-list').onclick = async (e) => {
    const id = e.target.dataset && e.target.dataset.del;
    if (!id) return;
    if (!window.confirm('删除这个群组？（不会删除已共享的 To Do，但其共享状态需重新选择群组）')) return;
    await GroupRepository.deleteGroup(id);
    renderGroups();
  };
}

/* ================= 我的 ================= */
function renderMine() {
  document.body.classList.remove('editing');
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

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 部分环境（如 file://）不支持 */ });
  });
}

render();
