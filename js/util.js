/* 公共业务逻辑 —— 与微信小程序端保持同一数据模型与同一规则
 * 数据模型对齐说明：createdAt/updatedAt 对应小程序的 createTime/updateTime（毫秒时间戳）；
 * 富文本沿用小程序的 segs 片段模型 [{t,b,i,u,s,c,bg,size,f}]，task.html 在 Web 端不落库，
 * 富文本序列化仍用 tasks[].rich 片段（跨端一致、天然防 XSS，不保存/执行任何 HTML 源码）。
 */

export const PRESET_CATEGORIES = { 1: '日常每天 Todo', 2: '旅游', 3: '工作', 4: '学习', 5: '个人生活' };

export const COLORS = [
  { key: 'peach', name: '蜜桃', accent: '#f0a37c', soft: '#fdeedd' },
  { key: 'butter', name: '奶油', accent: '#e9c46a', soft: '#fbf3dd' },
  { key: 'mint', name: '薄荷', accent: '#7fcf91', soft: '#e6f7ea' },
  { key: 'sky', name: '晴空', accent: '#7fb8e8', soft: '#e7f1fb' },
  { key: 'lavender', name: '薰衣草', accent: '#a795e0', soft: '#efeafb' },
  { key: 'rose', name: '玫瑰', accent: '#ef8fa8', soft: '#fce8ee' },
  { key: 'matcha', name: '抹茶', accent: '#9cbf5f', soft: '#eff6de' },
  { key: 'cocoa', name: '可可', accent: '#a0785a', soft: '#f1e8e0' }
];

export const FONT_FAMILY = {
  round: '"Yuanti SC","YouYuan","PingFang SC",sans-serif',
  kai: '"Kaiti SC",KaiTi,STKaiti,serif',
  song: '"Songti SC",SimSun,serif',
  cartoon: '"HanziPen SC","YouYuan","Comic Sans MS",cursive'
};

export const UNDERLINES = ['', 'single', 'double', 'wavy'];

export const PAPER_STYLES = ['plain', 'lines', 'grid', 'dots'];

export const TODO_TEMPLATES = [
  { id: 'travel-postcard', name: '旅行明信片', group: 'travel', paper: 'plain', cls: 'tpl-travel-postcard' },
  { id: 'travel-seaside', name: '海边假日', group: 'travel', paper: 'plain', cls: 'tpl-travel-seaside' },
  { id: 'travel-ticket', name: '城市旅行票据', group: 'travel', paper: 'plain', cls: 'tpl-travel-ticket' },
  { id: 'border-floral', name: '花朵边框', group: 'border', paper: 'plain', cls: 'tpl-border-floral' },
  { id: 'border-vine', name: '藤蔓边框', group: 'border', paper: 'plain', cls: 'tpl-border-vine' },
  { id: 'border-vintage-frame', name: '复古相框', group: 'border', paper: 'plain', cls: 'tpl-border-vintage-frame' },
  { id: 'plain-paper', name: '简约白纸', group: 'other', paper: 'plain', cls: '' },
  { id: 'lined-notebook', name: '横线笔记本', group: 'other', paper: 'lines', cls: '' },
  { id: 'grid-notebook', name: '方格笔记本', group: 'other', paper: 'grid', cls: '' },
  { id: 'dots-notebook', name: '点格笔记本', group: 'other', paper: 'dots', cls: '' },
  { id: 'minimal-business', name: '极简商务', group: 'other', paper: 'plain', cls: 'tpl-minimal-business' },
  { id: 'pink-journal', name: '粉色手账', group: 'other', paper: 'plain', cls: 'tpl-pink-journal' }
];

export const DEFAULT_TPL_BY_CAT = { 1: 'plain-paper', 2: 'travel-postcard', 3: 'minimal-business', 4: 'lined-notebook', 5: 'pink-journal' };

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const isHex = (v) => HEX_RE.test(v);

export function templateMeta(id) {
  return TODO_TEMPLATES.find((t) => t.id === id) || TODO_TEMPLATES.find((t) => t.id === 'plain-paper');
}
export function getDefaultTemplateByCategory(catId) {
  return DEFAULT_TPL_BY_CAT[catId] || 'plain-paper';
}

/* ---------- 时间 ---------- */
export function tsToDateStr(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function todayStr() { return tsToDateStr(Date.now()); }
export function fmtMinute(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function dayInfo(dateStr) {
  const t = todayStr();
  const y = tsToDateStr(Date.now() - 86400000);
  const tm = tsToDateStr(Date.now() + 86400000);
  let label = '';
  if (dateStr === t) label = '今天';
  else if (dateStr === y) label = '昨天';
  else if (dateStr === tm) label = '明天';
  const wd = WEEK[new Date(dateStr + 'T00:00:00').getDay()];
  return { week: wd, label: label ? `${dateStr.slice(5).replace('-', '月')}日 · ${label}` : `${dateStr.slice(5).replace('-', '月')}日 · ${wd}` };
}
export function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return tsToDateStr(d.getTime());
}
export function daysInMonth(ym) { // 'YYYY-MM' → 天数
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  if (!m) return 31;
  return new Date(+m[1], +m[2], 0).getDate();
}

/* ---------- Task / 富文本 ---------- */
export function emptyStyle() { return { b: 0, i: 0, u: '', s: 0, c: '', bg: '', size: 0, f: '' }; }

export function segSig(s) {
  return [s.b ? 1 : 0, s.i ? 1 : 0, s.u || '', s.s ? 1 : 0, s.c || '', s.bg || '', s.size || 0, s.f || ''].join('|');
}

/** seg 片段 → CSS 字符串（done 行灰化+删除线） */
export function segStyle(s, done) {
  const out = [];
  out.push('font-size:' + (s.size === 1 ? '13px' : s.size === 2 ? '19px' : s.size === 3 ? '24px' : '15px'));
  if (s.b) out.push('font-weight:700');
  if (s.i) out.push('font-style:italic');
  const deco = [];
  if (s.u) deco.push(s.u === 'double' ? 'underline double' : s.u === 'wavy' ? 'underline wavy' : 'underline');
  if (s.s && !done) deco.push('line-through');
  if (deco.length) out.push('text-decoration:' + deco.join(' '));
  if (s.c) out.push('color:' + s.c);
  if (s.bg) out.push('background:' + s.bg);
  if (s.f && FONT_FAMILY[s.f]) out.push('font-family:' + FONT_FAMILY[s.f]);
  if (done) { out.push('color:#9aa39b'); out.push('text-decoration:line-through'); }
  return out.join(';');
}

/** 旧数据兼容：hasCheckbox 缺省视为 true；v2.1 增加 level（缺省 1）与 parentId（仅二级） */
export function normalizeTask(task) {
  const level = task.level === 2 ? 2 : 1;
  return Object.assign({}, task, {
    hasCheckbox: task.hasCheckbox !== false,
    completed: !!task.completed,
    level,
    parentId: level === 2 ? (task.parentId || '') : undefined
  });
}

/** tasks 数组归一（兼容老数据/无 rich） */
export function normalizeTasks(tasks) {
  const arr = safeTasksArray(tasks);
  if (!arr.length) {
    return [{ id: uid(), text: '', completed: false, hasCheckbox: true }];
  }
  return arr.map((t) => normalizeTask(t || {}));
}

export function richFromSegs(segs) {
  const rich = segs.filter((s) => s.t).map((s) => {
    const o = { t: s.t };
    if (s.b) o.b = 1;
    if (s.i) o.i = 1;
    if (s.u) o.u = s.u;
    if (s.s) o.s = 1;
    if (s.c) o.c = s.c;
    if (s.bg) o.bg = s.bg;
    if (s.size) o.size = s.size;
    if (s.f) o.f = s.f;
    return o;
  });
  const styled = rich.some((x) => x.b || x.i || x.u || x.s || x.c || x.bg || x.size || x.f);
  return styled ? rich : null;
}

export function segsFromTask(task) {
  const rich = task.rich && task.rich.length ? task.rich : null;
  if (rich) {
    return rich.map((s) => ({
      t: s.t, b: s.b ? 1 : 0, i: s.i ? 1 : 0, u: s.u || '', s: s.s ? 1 : 0,
      c: s.c || '', bg: s.bg || '', size: s.size || 0, f: s.f || ''
    }));
  }
  return task.text ? [{ t: task.text, ...emptyStyle() }] : [];
}

/* ---------- 完成统计：只算带 checkbox 的 task ---------- */
export function tasksStat(tasks) {
  const cb = (tasks || []).filter((t) => t.hasCheckbox !== false);
  const done = cb.filter((t) => t.completed).length;
  return { total: cb.length, done, percent: cb.length ? Math.round((done / cb.length) * 100) : 0 };
}
export function isTodoCompleted(x) {
  const tasks = Array.isArray(x) ? x : safeTasksArray(x && x.tasks);
  const cb = tasks.filter((t) => t && t.hasCheckbox !== false);
  return cb.length > 0 && cb.every((t) => t.completed);
}

/* ---------- 整篇标题 ---------- */
export function getTodoTitle(todo) {
  if (todo && typeof todo.title === 'string' && todo.title.trim()) return todo.title.trim();
  const first = safeTasksArray(todo && todo.tasks).find((t) => t && (t.text || '').trim());
  if (first) return first.text.trim();
  return '未命名 Todo';
}
export function getTodoTitlePreview(todo, max = 24) {
  const t = getTodoTitle(todo);
  return t.length <= max ? t : t.slice(0, max) + '...';
}

/* 标题样式：默认 黑 #1f1f1f / 加粗 / 26px；titleStyle 只存改动项（b:0 表示关掉加粗） */
export function titleStyleCss(st) {
  const s = st || {};
  const out = [];
  out.push('color:' + (typeof s.c === 'string' && isHex(s.c) ? s.c : '#1f1f1f'));
  out.push('font-weight:' + (s.b === 0 ? '400' : '800'));
  out.push('font-size:' + (s.size === 1 ? '20px' : s.size === 2 ? '32px' : s.size === 3 ? '38px' : '26px'));
  if (s.i) out.push('font-style:italic');
  const deco = [];
  if (s.u) deco.push(s.u === 'double' ? 'underline double' : s.u === 'wavy' ? 'underline wavy' : 'underline');
  if (s.s) deco.push('line-through');
  if (deco.length) out.push('text-decoration:' + deco.join(' '));
  if (typeof s.bg === 'string' && isHex(s.bg)) out.push('background:' + s.bg);
  if (s.f && FONT_FAMILY[s.f]) out.push('font-family:' + FONT_FAMILY[s.f]);
  return out.join(';') + ';';
}
export function normalizeTitleStyle(st) {
  if (!st || typeof st !== 'object') return { b: 1 };
  const o = { b: st.b === 0 ? 0 : 1 };
  if (st.i) o.i = 1;
  if (st.s) o.s = 1;
  if (UNDERLINES.includes(st.u) && st.u) o.u = st.u;
  if (typeof st.c === 'string' && isHex(st.c)) o.c = st.c;
  if (typeof st.bg === 'string' && isHex(st.bg)) o.bg = st.bg;
  if (st.size === 1 || st.size === 2) o.size = st.size;
  if (st.f && FONT_FAMILY[st.f]) o.f = st.f;
  return o;
}

/* ---------- 筛选查找（与小程序规则一致） ---------- */
export function getTodoDate(todo) {
  return todo.targetDate || tsToDateStr(todo.createTime || Date.now());
}
export function filterTodos(todos, f) {
  return (todos || []).filter((todo) => {
    const d = getTodoDate(todo);
    if (f.selectedMonth && !d.startsWith(f.selectedMonth)) return false;
    if (f.selectedDate && d !== f.selectedDate) return false;
    if (f.selectedCategoryId != null && todo.categoryId !== f.selectedCategoryId) return false;
    if (f.keyword) {
      const kw = f.keyword.trim().toLowerCase();
      const title = getTodoTitle(todo).toLowerCase();
      const taskText = (todo.tasks || []).map((t) => t.text || '').join(' ').toLowerCase();
      const cat = (todo.categoryName || '').toLowerCase();
      if (!`${title} ${taskText} ${cat}`.includes(kw)) return false;
    }
    return true;
  });
}

/** 分类下拉选项：未分类 + 预设 1-5 + 自定义 6-10 */
export function categoryOptions(customCategories) {
  const opts = [{ id: 0, name: '未分类' }];
  for (let i = 1; i <= 5; i++) opts.push({ id: i, name: PRESET_CATEGORIES[i] });
  const custom = customCategories || [];
  for (let i = 0; i < 5; i++) {
    const name = custom[i];
    if (name) opts.push({ id: 6 + i, name });
  }
  return opts;
}

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
export function uid(prefix = 't') {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
export function inviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/** 转义 HTML（Web 端所有用户文本入库为数据、渲染为 text 节点或 style 字符串，双重防 XSS） */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* CSS 值只允许白名单字符（色号/字体 key），防止样式注入 */
export function safeCssColor(v) { return typeof v === 'string' && isHex(v) ? v : ''; }

/* ================= v2.0 每日 Todo（单日唯一一篇） ================= */

/** daily Todo 标题：'YYYY-MM-DD' → 'YYYYMMDD'（如 20261125） */
export function formatDailyTodoTitle(date) {
  return String(date || '').replace(/-/g, '');
}

/** 找到该日期唯一一篇 daily Todo；旧数据同天多篇时取 createTime 最早的一篇 */
export function getDailyTodoByDate(todos, date) {
  if (!Array.isArray(todos)) return null;
  const arr = (todos || []).filter((t) => t.moduleType === 'daily' && t.targetDate === date);
  if (!arr.length) return null;
  arr.sort((a, b) => (a.createTime || 0) - (b.createTime || 0));
  return arr[0];
}

/** 该 daily Todo 是否有真实内容（至少一条非空文本 task）——空 Todo 不计入列表 */
export function dailyHasContent(td) {
  return !!(td && (td.tasks || []).some((t) => (t.text || '').trim()));
}

/**
 * 兼容旧数据：同一天多篇 daily 合并为一篇（tasks 串接；createTime 取最早、updateTime 取最新；
 * 标题统一 YYYYMMDD）。不直接删除数据；_mergedFrom 记录来源 id，由调用方决定合并落库。
 */
export function mergeDuplicateDailyTodos(todos) {
  if (!Array.isArray(todos)) return [];
  const map = new Map();
  const result = [];
  for (const todo of todos || []) {
    if (todo.moduleType !== 'daily' || !todo.targetDate) { result.push(todo); continue; }
    const key = todo.targetDate;
    const id = todo.id || todo._id || '';
    if (!map.has(key)) {
      const merged = Object.assign({}, todo, {
        title: formatDailyTodoTitle(todo.targetDate),
        titleCustom: true,
        tasks: safeTasksArray(todo.tasks).slice(),
        _mergedFrom: [id]
      });
      map.set(key, merged);
      result.push(merged);
      continue;
    }
    const exist = map.get(key);
    exist.tasks = safeTasksArray(exist.tasks).concat(safeTasksArray(todo.tasks));
    if ((todo.createTime || 0) && (todo.createTime < (exist.createTime || Infinity))) exist.createTime = todo.createTime;
    if ((todo.updateTime || 0) > (exist.updateTime || 0)) exist.updateTime = todo.updateTime;
    exist._mergedFrom.push(id);
  }
  for (const td of result) {
    if (td._mergedFrom && td._mergedFrom.length > 1) td.isDone = isTodoCompleted(td.tasks);
  }
  return result;
}

/* ================= v2.3 新增纯函数 ================= */
/* v2.4.4 毒数据免疫：tasks 可能是对象/字符串/缺失，一律安全转数组 */
export function safeTasksArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p; } catch (e) { /* ignore */ }
    return [];
  }
  if (v && typeof v === 'object') {
    const vals = Object.values(v);
    if (vals.length && vals.every((x) => x && typeof x === 'object')) return vals;
    return [];
  }
  return [];
}
/* 进度实时计算：只统计带勾选框/圆圈的一二级 task；任何改动后调用即得最新值 */
export function getTodoProgress(todo) {
  const tasks = safeTasksArray(todo && todo.tasks);
  const checkable = tasks.filter((t) => t && t.hasCheckbox !== false);
  const total = checkable.length;
  const done = checkable.filter((t) => t.completed).length;
  return {
    totalTasks: total,
    completedTasks: done,
    unfinishedTasks: total - done,
    progressPercent: total === 0 ? 0 : Math.round((done / total) * 100)
  };
}
export function hasUnfinishedCheckableTasks(todo) {
  const c = safeTasksArray(todo && todo.tasks).filter((t) => t && t.hasCheckbox !== false);
  return c.length > 0 && c.some((t) => !t.completed);
}
/* 过去 7 天（不含今天）中有未完成可勾选任务的日期，倒序 */
export function weekUnfinishedDates(todos, today) {
  if (!Array.isArray(todos)) return [];
  const out = [];
  for (let i = 1; i <= 7; i++) {
    const d = shiftDate(today, -i);
    const doc = (todos || []).find((t) => t.moduleType === 'daily' && t.targetDate === d);
    if (doc && hasUnfinishedCheckableTasks(doc)) {
      out.push({ date: d, count: getTodoProgress(doc).unfinishedTasks });
    }
  }
  return out;
}
export function fmtShortDate(d) {
  const p = String(d || '').split('-');
  return p.length === 3 ? Number(p[1]) + '.' + Number(p[2]) : String(d || '');
}
/* 专题排序：置顶优先（pinnedAt 倒序），其余按 updateTime 倒序 */
export function sortTopicTodos(todos) {
  return [...(todos || [])].sort((a, b) => {
    const ap = a.isPinned ? 1 : 0, bp = b.isPinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (ap && bp) return String(b.pinnedAt || '').localeCompare(String(a.pinnedAt || ''));
    return (b.updateTime || 0) - (a.updateTime || 0);
  });
}
/* 主题：莫兰迪治愈系；背景：简单卡通（CSS 绘制，不影响阅读） */
export const THEMES = [
  { id: 'cream', name: '奶油白' },
  { id: 'morandi-green', name: '莫兰迪绿' },
  { id: 'haze-blue', name: '雾霾蓝' },
  { id: 'sakura', name: '樱花粉' },
  { id: 'milk-tea', name: '奶茶棕' }
];
export const THEME_BGS = [
  { id: 'none', name: '无背景' },
  { id: 'cloud', name: '云朵背景' },
  { id: 'star', name: '小星星背景' },
  { id: 'flower', name: '小花背景' }
];
/* 中国法定节假日内置表（以国务院办公厅每年通知为准；未内置年份会在界面提示手动配置） */
export const CHINA_CALENDAR = {
  2026: {
    holidays: ['2026-01-01', '2026-01-02', '2026-01-03',
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
      '2026-04-04', '2026-04-05', '2026-04-06',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'],
    extraWorkdays: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-10-10']
  }
};
export function chinaCalendarFor(year) {
  const c = CHINA_CALENDAR[year];
  return c ? { year: Number(year), holidays: c.holidays.slice(), extraWorkdays: c.extraWorkdays.slice(), configured: true } : null;
}
export function isChinaLegalHoliday(dateStr, cal) {
  const y = Number(String(dateStr).slice(0, 4));
  const c = (cal && cal.year === y) ? cal : (CHINA_CALENDAR[y] || null);
  return !!(c && (c.holidays || []).includes(dateStr));
}
/* 法定工作日：优先用户配置/内置中国日历；无配置年份=周一至周五并提示未配置 */
export function defaultCalendar(year) {
  return chinaCalendarFor(year) || { year: year, holidays: [], extraWorkdays: [], configured: false };
}
export function isLegalWorkday(dateStr, cal) {
  const c = cal || { holidays: [], extraWorkdays: [] };
  const h = (c.holidays || []).map(String), x = (c.extraWorkdays || []).map(String);
  if (h.includes(dateStr)) return false;
  if (x.includes(dateStr)) return true;
  const day = tsToDateStr ? new Date(dateStrToTsLocal(dateStr)).getDay() : 0;
  return day !== 0 && day !== 6;
}
function dateStrToTsLocal(d) {
  const p = String(d).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]).getTime();
}
/* 规则在 [start,end] 区间内命中的日期列表 */
export function datesForRule(rule, start, end, cal) {
  const out = [];
  if (!rule) return out;
  let cur = start;
  let guard = 0;
  while (cur <= end && guard < 400) {
    guard++;
    if (rule.type === 'weekly') {
      const p = cur.split('-').map(Number);
      const wd = new Date(p[0], p[1] - 1, p[2]).getDay();
      const norm = wd === 0 ? 7 : wd;
      if ((rule.weekdays || []).includes(norm)) out.push(cur);
    } else if (rule.type === 'legal-workday') {
      if (isLegalWorkday(cur, cal)) out.push(cur);
    } else if (rule.type === 'legal-holiday') {
      if (isChinaLegalHoliday(cur, cal)) out.push(cur);
    } else if (rule.type === 'date-range') {
      if (rule.startDate && rule.endDate && cur >= rule.startDate && cur <= rule.endDate) out.push(cur);
    }
    cur = shiftDate(cur, 1);
  }
  return out;
}
export function hasTaskFromRule(todo, ruleId) {
  return ((todo && todo.tasks) || []).some((t) => t && t.sourceRuleId === ruleId);
}
