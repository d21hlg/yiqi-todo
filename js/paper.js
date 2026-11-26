/* paper.js —— 纸张编辑器（整篇标题 + Task List + 独立编辑工具模块 + 浮动格式条）
 * 交互规则（与小程序端一致）：
 *  - 一整篇 Todo 只有一个标题，位于所有 task 上方；默认黑色/加粗/大字号，创建后可改文本与格式
 *  - 先输入文字 → 选中文字（原生拖选） → 在编辑工具模块 / 浮动条中改格式；格式只作用于选中范围
 *  - 未拉选区但选中了某行 → 工具作用于整行；点过标题 → 工具作用于标题整体
 *  - checkbox 是 task 的可选元素：默认有；添加/删除统一在编辑工具模块中；删除不删除文本与格式
 *  - 富文本内部模型 = segs 片段 [{t,b,i,u,s,c,bg,size,f}]（不落 HTML 源码，天然防 XSS）
 */
import {
  segsFromTask, richFromSegs, segStyle, segSig, emptyStyle, normalizeTitleStyle, titleStyleCss,
  UNDERLINES, COLORS, uid, esc, isHex
} from './util.js';

let seq = 0;

function newRow(task, idx) {
  seq += 1;
  const t = task || {};
  return {
    key: 'w' + seq + '_' + (idx || 0),
    id: t.id || uid('t'),
    completed: !!t.completed,
    hasCheckbox: t.hasCheckbox !== false,
    // v2.1：level 1|2（旧数据缺省一级，方形勾选框）；二级为圆圈并记录 parentId
    level: t.level === 2 ? 2 : 1,
    parentId: t.level === 2 ? (t.parentId || '') : '',
    textType: t.textType === 'heading1' || t.textType === 'heading2' ? t.textType : 'normal',
    countInProgress: t.countInProgress === false ? false : undefined,
    segs: segsFromTask(t)
  };
}

function segsToHtml(segs, done) {
  if (!segs.length) return '';
  return segs.map((s, i) =>
    `<span data-si="${i}" data-b="${s.b ? 1 : 0}" data-i="${s.i ? 1 : 0}" data-u="${esc(s.u)}" data-s="${s.s ? 1 : 0}" data-c="${esc(s.c)}" data-bg="${esc(s.bg)}" data-size="${s.size || 0}" data-f="${esc(s.f)}" style="${esc(segStyle(s, done))}">${esc(s.t)}</span>`
  ).join('');
}

export function createPaperEditor(opts) {
  const mount = opts.mount;
  const readonly = opts.editable === false; // 必须在所有使用点之前声明（TDZ 修复）
  // 浮动条已废弃（v2.4 改为 sticky 工具卡），保留桩对象兼容旧引用
  const floatBar = { classList: { add() {}, remove() {}, toggle() {} }, style: {}, addEventListener() {}, remove() {} };
  const onChange = opts.onChange || (() => {});
  const rawInit = opts.initial && opts.initial.tasks;
  const initTasks = Array.isArray(rawInit) ? rawInit
    : (rawInit && typeof rawInit === 'object' ? Object.values(rawInit).filter((x) => x && typeof x === 'object') : []);
  const rows = (initTasks.length ? initTasks : [null]).map((t, i) => newRow(t, i));
  let titleVal = (opts.initial && opts.initial.title) || '';
  let titleSt = normalizeTitleStyle(opts.initial && opts.initial.titleStyle);
  let activeRowKey = '';
  let titleFocused = false;
  let sel = null; // { key, start, end }
  let destroyed = false;

  /* ---------- 骨架 ---------- */
  mount.innerHTML = `
    <div class="paper ${esc(opts.paperClass || '')}" id="pe-paper">
      <input class="todo-title-input" id="pe-title" value="${esc(titleVal)}" placeholder="请输入标题" maxlength="80" ${opts.hideTitle ? 'hidden' : ''} />
      <div class="todo-title-divider" ${opts.hideTitle ? 'hidden' : ''}></div>
      <div id="pe-rows"></div>
      ${readonly ? '' : `<div class="checkbox-control-bar" id="pe-ckbar">
        <button class="ckbar-btn" data-ckbar="1" title="给当前任务添加/删除一级方形勾选框；未选中任务时新建一级任务">☐ 一级</button>
        <button class="ckbar-btn" data-ckbar="2" title="给当前任务添加/删除二级圆形勾选框；未选中任务时新建二级任务">○ 二级</button>
        <span class="t-mut">作用于当前选中的任务行</span>
      </div>`}
      <div class="paper-add" id="pe-add">＋ 添加任务</div>
    </div>
    <div class="card tools-card is-hidden" id="pe-tools">
      <div class="tools-head">
        <span class="tools-title">文字编辑</span>
        <span class="t-mut" id="pe-target">当前选中：未选择</span>
        <span class="spacer"></span>
        <span class="tool-close" id="pe-close" title="收起编辑栏">×</span>
      </div>
      <div class="tool-l1">
        <button class="tool-btn l1" data-pan="title">标题</button>
        <button class="tool-btn l1" data-pan="fmt">样式</button>
        <button class="tool-btn l1" data-pan="size">字号</button>
        <button class="tool-btn l1" data-pan="color">文字色</button>
        <button class="tool-btn l1" data-pan="bg">背景色</button>
        <button class="tool-btn l1 ckbtn" data-ck="1" title="添加/删除一级方形勾选框">☐ 一级</button>
        <button class="tool-btn l1 ckbtn" data-ck="2" title="添加/删除二级圆形勾选框">○ 二级</button>
      </div>
      <div class="tool-pan" id="pe-pan-title" hidden>
        <span class="tool" data-tt="normal">普通文字</span>
        <span class="tool" data-tt="heading1">一级标题</span>
        <span class="tool" data-tt="heading2">二级标题</span>
        <span class="t-mut">标题类不计入进度</span>
      </div>
      <div class="tool-pan" id="pe-pan-fmt" hidden>
        <span class="tool chip-b" data-fmt="b">B</span>
        <span class="tool chip-i" data-fmt="i">I</span>
        <span class="tool chip-u" data-fmt="u">U</span>
        <span class="tool chip-s" data-fmt="s">S</span>
        <span class="tool danger" id="pe-clear">清除格式</span>
      </div>
      <div class="tool-pan" id="pe-pan-size" hidden>
        <span class="tool" data-size="0">标准</span>
        <span class="tool" data-size="1">小</span>
        <span class="tool" data-size="2">大</span>
        <span class="tool" data-size="3">特大</span>
      </div>
      <div class="tool-pan" id="pe-pan-color" hidden>
        <span class="dot none" data-c=""></span>
        ${COLORS.map((c) => `<span class="dot" data-c="${c.accent}" style="background:${c.accent}" title="${c.name}"></span>`).join('')}
        <input class="hex-input" id="pe-hexc" placeholder="#7fcf91" maxlength="7" />
      </div>
      <div class="tool-pan" id="pe-pan-bg" hidden>
        <span class="dot none" data-bg=""></span>
        ${COLORS.map((c) => `<span class="dot" data-bg="${c.soft}" style="background:${c.soft}" title="${c.name}"></span>`).join('')}
        <input class="hex-input" id="pe-hexbg" placeholder="#f8e7a1" maxlength="7" />
      </div>
    </div>`;

  const $ = (sel2) => mount.querySelector(sel2);
  if (readonly) mount.classList.add('pe-readonly');
  const rowsEl = $('#pe-rows');
  const titleEl = $('#pe-title');
  const targetEl = $('#pe-target');

  titleEl.style.cssText = titleStyleCss(titleSt);

  /* ---------- 渲染 ---------- */
  function renderRows() {
    rowsEl.innerHTML = rows.map((r) => {
      const done = r.hasCheckbox && r.completed;
      const check = r.hasCheckbox
        ? `<span class="pcheck ${r.level === 2 ? 'circle' : ''} ${done ? 'on' : ''}" data-act="check" data-key="${r.key}" aria-label="${done ? '取消完成' : '标记完成'}"></span>`
        : '';
      return `<div class="task-row ${r.level === 2 ? 'level-2' : 'level-1'} ${r.hasCheckbox === false ? 'no-ctrl' : ''} ${activeRowKey === r.key ? 'active' : ''}" data-key="${r.key}">
        ${check}
        <div class="task-content ${done ? 'done' : ''} ${r.textType === 'heading1' ? 'heading-1' : r.textType === 'heading2' ? 'heading-2' : ''}" contenteditable="${readonly ? 'false' : 'true'}" spellcheck="false"
          data-ph="写一条任务…" data-key="${r.key}">${segsToHtml(r.segs, done)}</div>
        ${readonly ? '' : `<span class="task-del" data-act="del" data-key="${r.key}">⋯</span>`}
      </div>`;
    }).join('');
    placeToolsAfterActive(); // v2.4.3：innerHTML 重建后把编辑栏挂回当前 task 下方
  }

  function rowByKey(key) { return rows.find((r) => r.key === key); }
  function rowIdx(key) { return rows.findIndex((r) => r.key === key); }
  function elByKey(key) { return rowsEl.querySelector(`.task-content[data-key="${key}"]`); }

  function syncTarget() {
    let label = '未选择';
    if (titleFocused) label = '标题';
    else if (sel) label = `第 ${rowIdx(sel.key) + 1} 行 · 已选中文字`;
    else if (activeRowKey) {
      const ar = rowByKey(activeRowKey);
      label = `第 ${rowIdx(activeRowKey) + 1} 行${ar && ar.level === 2 ? ' · 二级' : ''}`;
    }
    const t = $('#pe-target');
    if (t) t.textContent = '当前选中：' + label;
  }

  function emit() { onChange(getPayload()); }

  function getPayload() {
    return {
      title: titleVal.trim(),
      titleStyle: titleSt,
      tasks: rows.map((r) => {
        const text = r.segs.map((s) => s.t).join('');
        const rich = richFromSegs(r.segs);
        const task = {
          id: r.id,
          text,
          completed: !!(r.hasCheckbox && r.completed),
          hasCheckbox: r.hasCheckbox,
          level: r.level === 2 ? 2 : 1,
          textType: r.textType && r.textType !== 'normal' ? r.textType : undefined,
          countInProgress: r.countInProgress === false ? false : undefined
        };
        if (task.level === 2 && r.parentId) task.parentId = r.parentId;
        if (rich) task.rich = rich;
        return task;
      })
    };
  }

  /* ---------- DOM → segs ---------- */
  function parseRowEl(el) {
    const chars = [];
    const readNode = (node, style) => {
      if (node.nodeType === Node.TEXT_NODE) {
        for (const ch of node.textContent) chars.push(Object.assign({ ch }, style));
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const st = node.dataset && node.dataset.si !== undefined ? {
          b: node.dataset.b === '1' ? 1 : 0, i: node.dataset.i === '1' ? 1 : 0,
          u: node.dataset.u || '', s: node.dataset.s === '1' ? 1 : 0,
          c: node.dataset.c || '', bg: node.dataset.bg || '',
          size: Number(node.dataset.size) || 0, f: node.dataset.f || ''
        } : emptyStyle();
        node.childNodes.forEach((n) => readNode(n, st));
      }
    };
    el.childNodes.forEach((n) => readNode(n, null));
    // 相邻同样式合并
    const segs = [];
    for (const c of chars) {
      const st = Object.assign(emptyStyle(), c);
      delete st.ch; // 先取纯样式
      const styleOnly = { b: c.b || 0, i: c.i || 0, u: c.u || '', s: c.s || 0, c: c.c || '', bg: c.bg || '', size: c.size || 0, f: c.f || '' };
      const last = segs[segs.length - 1];
      if (last && segSig(last) === segSig(styleOnly)) last.t += c.ch;
      else segs.push(Object.assign({ t: c.ch }, styleOnly));
      void st;
    }
    return segs.filter((s) => s.t !== '' || segs.length === 1);
  }

  function charsOf(row) {
    const arr = [];
    row.segs.forEach((s) => {
      for (const ch of s.t) {
        arr.push({ ch, b: s.b ? 1 : 0, i: s.i ? 1 : 0, u: s.u || '', s: s.s ? 1 : 0, c: s.c || '', bg: s.bg || '', size: s.size || 0, f: s.f || '' });
      }
    });
    return arr;
  }

  function rebuildRow(row, arr) {
    const segs = [];
    for (const c of arr) {
      const st = { b: c.b || 0, i: c.i || 0, u: c.u || '', s: c.s || 0, c: c.c || '', bg: c.bg || '', size: c.size || 0, f: c.f || '' };
      const last = segs[segs.length - 1];
      if (last && segSig(last) === segSig(st)) last.t += c.ch;
      else segs.push(Object.assign({ t: c.ch }, st));
    }
    row.segs = segs;
  }

  function rerenderRow(key, caretOffset) {
    const row = rowByKey(key);
    const el = elByKey(key);
    if (!row || !el) return;
    const done = row.hasCheckbox && row.completed;
    el.classList.toggle('done', done);
    el.innerHTML = segsToHtml(row.segs, done);
    el.classList.toggle('heading-1', row.textType === 'heading1');
    el.classList.toggle('heading-2', row.textType === 'heading2');
    const rowEl = el.parentNode;
    const old = rowEl.querySelector('.pcheck, .pcheck-ghost');
    if (row.hasCheckbox === false) {
      if (old) old.remove();
      rowEl.classList.add('no-ctrl');
    } else {
      rowEl.classList.remove('no-ctrl');
      const cls = `pcheck ${row.level === 2 ? 'circle' : ''} ${done ? 'on' : ''}`;
      if (old) old.className = cls;
      else {
        const sp = document.createElement('span');
        sp.className = cls; sp.dataset.act = 'check'; sp.dataset.key = row.key;
        rowEl.insertBefore(sp, el);
      }
    }
    rowEl.classList.toggle('level-2', row.level === 2);
    rowEl.classList.toggle('level-1', row.level !== 2);
    if (caretOffset != null) setCaret(el, caretOffset);
  }

  /* v2.6.5：只重绘行外壳（勾选控件/层级类/标题类），不碰 contenteditable 内容 → 输入法不跳 */
  function rerenderRowChrome(key) {
    const row = rowByKey(key);
    const el = elByKey(key);
    if (!row || !el) return;
    const done = row.hasCheckbox && row.completed;
    el.classList.toggle('done', done);
    el.classList.toggle('heading-1', row.textType === 'heading1');
    el.classList.toggle('heading-2', row.textType === 'heading2');
    const rowEl = el.parentNode;
    const old = rowEl.querySelector('.pcheck, .pcheck-ghost');
    if (row.hasCheckbox === false) {
      if (old) old.remove();
      rowEl.classList.add('no-ctrl');
    } else {
      rowEl.classList.remove('no-ctrl');
      const cls = `pcheck ${row.level === 2 ? 'circle' : ''} ${done ? 'on' : ''}`;
      if (old) old.className = cls;
      else {
        const sp = document.createElement('span');
        sp.className = cls; sp.dataset.act = 'check'; sp.dataset.key = row.key;
        rowEl.insertBefore(sp, el);
      }
    }
    rowEl.classList.toggle('level-2', row.level === 2);
    rowEl.classList.toggle('level-1', row.level !== 2);
  }

  /* 恢复光标但不引起手机键盘跳动：已在编辑则不重复 focus */
  function restoreCaret(key, offset) {
    requestAnimationFrame(() => {
      const el2 = elByKey(key);
      if (!el2) return;
      const ae = document.activeElement;
      if (ae !== el2 && !(el2.contains && el2.contains(ae))) {
        el2.focus({ preventScroll: true });
      }
      setCaret(el2, offset);
    });
  }

  /* 受控合并：当前行文字(+富文本)追加到上一行末尾，删除当前行，光标落在上一行原文末尾 */
  function mergeIntoPrevious(row) {
    const idx = rowIdx(row.key);
    if (idx <= 0) {
      restoreCaret(row.key, 0); // 没有上一条：保留当前行，不乱合并
      return;
    }
    const prev = rows[idx - 1];
    const prevEl = elByKey(prev.key);
    const caretOff = prevEl ? (prevEl.textContent || '').length : prev.segs.map((x) => x.t).join('').length;
    prev.segs = prev.segs.concat(row.segs);
    rows.splice(idx, 1);
    if (activeRowKey === row.key) activeRowKey = prev.key;
    sel = null;
    renderRows();
    syncTarget();
    emit();
    restoreCaret(prev.key, caretOff);
    toast('已合并到上一条');
  }

  function setCaret(el, offset) {
    const range = document.createRange();
    const selObj = window.getSelection();
    let idx = 0;
    let placed = false;
    const walk = (node) => {
      if (placed) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.textContent.length;
        if (idx + len >= offset) {
          range.setStart(node, Math.max(0, Math.min(offset - idx, len)));
          placed = true;
          return;
        }
        idx += len;
      } else {
        node.childNodes.forEach(walk);
        if (!placed && idx === offset) { range.setStart(node.parentNode || node, 0); placed = true; }
      }
    };
    walk(el);
    if (!placed) range.selectNodeContents(el), range.collapse(false);
    range.collapse(true);
    selObj.removeAllRanges();
    selObj.addRange(range);
  }

  /* ---------- 选区跟踪 ---------- */
  function readSelection() {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0) return null;
    const r = s.getRangeAt(0);
    let el = null;
    if (r.startContainer.nodeType === Node.TEXT_NODE) el = r.startContainer.parentElement;
    else el = r.startContainer;
    const content = el && el.closest ? el.closest('.task-content') : null;
    if (!content || !rowsEl.contains(content)) return null;
    // 逐文本节点算字符偏移
    let idx = 0; let start = null; let end = null;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      const len = n.textContent.length;
      if (n === r.startContainer) start = idx + r.startOffset;
      if (n === r.endContainer) end = idx + r.endOffset;
      idx += len;
    }
    if (start == null || end == null) return null;
    if (start > end) { const t2 = start; start = end; end = t2; }
    return { key: content.dataset.key, start, end };
  }

  function positionFloatBar() {
    showTools();
    const s = window.getSelection();
    if (!s || s.rangeCount === 0 || s.isCollapsed) { floatBar.classList.remove('show'); return; }
    const rect = s.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { floatBar.classList.remove('show'); return; }
    floatBar.classList.add('show');
    const x = Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150);
    floatBar.style.left = x + 'px';
    floatBar.style.top = (rect.top + window.scrollY - 8) + 'px';
  }

  function onSelectionChange() {
    if (destroyed) return;
    const r = readSelection();
    if (r && r.start !== r.end) {
      sel = r;
      activeRowKey = r.key;
      titleFocused = false;
      positionFloatBar();
    } else {
      sel = null;
      floatBar.classList.remove('show');
      const ae = document.activeElement;
      if (ae && ae.classList && ae.classList.contains('task-content')) {
        activeRowKey = ae.dataset.key;
        titleFocused = false;
      }
    }
    syncTarget();
  }

  /* ---------- 工具动作 ---------- */
  function toast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hide');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.add('hide'), 1800);
  }
  paper_toast = toast;

  function applyToSelection(mut) {
    if (!sel) return false;
    const row = rowByKey(sel.key);
    if (!row) return false;
    const arr = charsOf(row);
    for (let i = sel.start; i < sel.end && i < arr.length; i++) mut(arr[i]);
    rebuildRow(row, arr);
    rerenderRow(sel.key, sel.end);
    sel = null;
    floatBar.classList.remove('show');
    syncTarget();
    emit();
    return true;
  }

  function applyWholeRow(mut) {
    const row = rowByKey(activeRowKey);
    if (!row) return false;
    const arr = charsOf(row);
    if (!arr.length) { toast('请先输入内容，再选中修改格式'); return false; }
    arr.forEach(mut);
    rebuildRow(row, arr);
    rerenderRow(activeRowKey, null);
    emit();
    return true;
  }

  function applyTitle(mut) {
    titleSt = Object.assign({}, titleSt);
    mut(titleSt);
    titleEl.style.cssText = titleStyleCss(titleSt);
    emit();
  }

  /** 分发：选中文字 > 标题 > 当前行 */
  function dispatch(selFn, titleFn, rowFn) {
    if (sel) { selFn(); return; }
    if (titleFocused) { titleFn(); return; }
    if (activeRowKey) { rowFn(); return; }
    toast('请先选择一行内容');
  }

  function toggleField(field) {
    dispatch(
      () => {
        const row = rowByKey(sel.key);
        const arr = charsOf(row);
        let all = true;
        for (let i = sel.start; i < sel.end && i < arr.length; i++) if (!arr[i][field]) { all = false; break; }
        applyToSelection((st) => { st[field] = all ? 0 : 1; });
      },
      () => applyTitle((st) => { st[field] = st[field] ? 0 : 1; }),
      () => {
        const arr = charsOf(rowByKey(activeRowKey));
        let all = arr.length > 0;
        arr.forEach((c) => { if (!c[field]) all = false; });
        applyWholeRow((st) => { st[field] = all ? 0 : 1; });
      }
    );
  }

  function cycleU() {
    const nextOf = (cur) => UNDERLINES[(UNDERLINES.indexOf(cur || '') + 1) % UNDERLINES.length];
    dispatch(
      () => {
        const row = rowByKey(sel.key);
        const arr = charsOf(row);
        const next = nextOf(arr[sel.start] && arr[sel.start].u);
        applyToSelection((st) => { st.u = next; });
      },
      () => applyTitle((st) => { const n = nextOf(st.u); if (n) st.u = n; else delete st.u; }),
      () => {
        const arr = charsOf(rowByKey(activeRowKey));
        if (!arr.length) { toast('请先输入内容，再选中修改格式'); return; }
        const next = nextOf(arr[0].u);
        applyWholeRow((st) => { st.u = next; });
      }
    );
  }

  function setSize(size) {
    dispatch(
      () => applyToSelection((st) => { st.size = size; }),
      () => applyTitle((st) => { if (size) st.size = size; else delete st.size; }),
      () => applyWholeRow((st) => { st.size = size; })
    );
  }

  function setColor(field, v) {
    if (v && !isHex(v)) { toast('色号格式如 #7fcf91'); return; }
    dispatch(
      () => applyToSelection((st) => { if (field === 'c') st.c = st.c === v ? '' : v; else st.bg = st.bg === v ? '' : v; }),
      () => applyTitle((st) => { if (v) st[field] = v; else delete st[field]; }),
      () => applyWholeRow((st) => { if (field === 'c') st.c = st.c === v ? '' : v; else st.bg = st.bg === v ? '' : v; })
    );
  }

  function clearFormat() {
    dispatch(
      () => applyToSelection((st) => Object.assign(st, emptyStyle())),
      () => { titleSt = normalizeTitleStyle({ b: 1 }); titleEl.style.cssText = titleStyleCss(titleSt); emit(); },
      () => applyWholeRow((st) => Object.assign(st, emptyStyle()))
    );
  }

  /* ---------- 事件绑定 ---------- */
  titleEl.addEventListener('input', () => {
    titleVal = titleEl.value;
    emit();
  });
  titleEl.addEventListener('focus', () => {
    titleFocused = true;
    sel = null;
    floatBar.classList.remove('show');
    syncTarget();
  });

  rowsEl.addEventListener('input', (e) => {
    const el = e.target.closest('.task-content');
    if (!el) return;
    const row = rowByKey(el.dataset.key);
    if (!row) return;
    row.segs = parseRowEl(el);
    activeRowKey = el.dataset.key;
    titleFocused = false;
    syncTarget();
    emit();
  });
  rowsEl.addEventListener('focusin', (e) => {
    const el = e.target.closest('.task-content');
    if (!el) return;
    activeRowKey = el.dataset.key;
    titleFocused = false;
    rowsEl.querySelectorAll('.task-row').forEach((tr) => tr.classList.toggle('active', tr.dataset.key === activeRowKey));
    placeToolsAfterActive();
    syncTarget();
  });
  rowsEl.addEventListener('click', (e) => {
    // v2.6：点勾选框只切换完成，不唤出编辑栏；点文字区域才唤出
    if (e.target.closest && e.target.closest('.task-row') && !e.target.closest('.pcheck')) showTools();
    const act = e.target.dataset && e.target.dataset.act;
    const key = e.target.dataset && e.target.dataset.key;
    if (!act || !key) return;
    const row = rowByKey(key);
    if (!row) return;
    if (act === 'check') {
      if (!row.hasCheckbox) return;
      row.completed = !row.completed; // 仅切换完成 + 进度 + 保存，不 focus、不弹编辑栏
      rerenderRow(key, null);
      emit();
    } else if (act === 'activate') {
      activeRowKey = key;
      titleFocused = false;
      elByKey(key) && elByKey(key).focus();
      syncTarget();
    } else if (act === 'del') {
      if (row.hasCheckbox === false && window.confirm('给这条纯文本行加回勾选控件？\n（点「取消」则删除整条任务）')) {
        row.hasCheckbox = true;
        row.completed = false;
        rerenderRow(key, null);
        syncTarget();
        emit();
        return;
      }
      if (!window.confirm('删除这条任务？')) return;
      const idx = rowIdx(key);
      rows.splice(idx, 1);
      if (!rows.length) rows.push(newRow(null, 0));
      if (activeRowKey === key) activeRowKey = '';
      sel = null;
      renderRows();
      syncTarget();
      emit();
    }
  });

  function addRowAt() {
    if (rows.length >= 50) { toast('一张纸最多 50 行'); return null; }
    const r = newRow(null, rows.length);
    rows.push(r);
    renderRows();
    activeRowKey = r.key;
    syncTarget();
    const el = elByKey(r.key);
    if (el) el.focus();
    emit();
    return r;
  }
  $('#pe-add').addEventListener('click', () => addRowAt());
  const ckbar = $('#pe-ckbar');
  if (ckbar) {
    ckbar.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢 editor 焦点 → 键盘不收起
    ckbar.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-ckbar]');
      if (!b) return;
      const level = Number(b.dataset.ckbar);
      const row = currentRow();
      if (!row) {
        // 未选中任务：直接新建对应类型任务并聚焦
        if (rows.length >= 50) { toast('一张纸最多 50 行'); return; }
        let parentId = '';
        if (level === 2) {
          for (let i = rows.length - 1; i >= 0; i--) { if ((rows[i].level || 1) === 1) { parentId = rows[i].id; break; } }
        }
        const nr = newRow({ id: uid('t'), hasCheckbox: true, completed: false, level: level, parentId: parentId, textType: 'normal' }, rows.length);
        rows.push(nr);
        renderRows();
        activeRowKey = nr.key;
        syncTarget();
        const el2 = elByKey(nr.key);
        if (el2) el2.focus();
        showTools();
        emit();
        return;
      }
      toggleCheckLevel(level);
    });
  }

  /* ---------- v2.1 层级：提升为一级 / 降级为二级 ---------- */
  function promoteRow() {
    const row = rowByKey(activeRowKey);
    if (!row || titleFocused) { toast('请先选择一行内容'); return; }
    if (row.level !== 2) { toast('当前已是一级任务'); return; }
    row.level = 1;
    row.parentId = '';
    renderRows();
    syncTarget();
    emit();
    toast('已提升为一级任务（方形勾选框）');
  }

  function demoteRow() {
    const row = rowByKey(activeRowKey);
    if (!row || titleFocused) { toast('请先选择一行内容'); return; }
    if (row.level === 2) { toast('当前已是二级任务'); return; }
    const idx = rowIdx(row.key);
    let parent = null;
    for (let i = idx - 1; i >= 0; i--) {
      if ((rows[i].level || 1) === 1) { parent = rows[i]; break; }
    }
    if (!parent) { toast('上方没有可归属的一级任务'); return; }
    row.level = 2;
    row.parentId = parent.id;
    renderRows();
    syncTarget();
    emit();
    toast('已降级为二级任务（圆圈）');
  }

  /* ---------- v2.1 键盘：Enter=下方新建二级；行首 Backspace=删除勾选控件 ---------- */
  /* v2.6.3 稳定光标判断：字符 offset（兼容 caret 落在元素节点/空行/嵌套 span 的情况） */
  function caretOffset(el) {
    const s2 = window.getSelection();
    if (!s2 || !s2.rangeCount) return -1;
    const r = s2.getRangeAt(0);
    if (!r.collapsed) return -1;
    if (!el.contains(r.startContainer)) return -1;
    const pre = r.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  }
  function caretAtEnd(el) {
    const off = caretOffset(el);
    return off >= 0 && off === (el.textContent || '').length;
  }
  function caretAtStart(el) {
    return caretOffset(el) === 0;
  }

  let composing = false; // 中文输入法组合态：期间不响应删除键控控件
  rowsEl.addEventListener('compositionstart', () => { composing = true; });
  rowsEl.addEventListener('compositionend', () => { composing = false; });
  let lastDelLock = null; // keydown 与 beforeinput 双触发 80ms 锁
  function dupDeleteLocked(key) {
    const now = Date.now();
    if (lastDelLock && lastDelLock.key === key && now - lastDelLock.t < 80) return true;
    lastDelLock = { key: key, t: now };
    return false;
  }

  /* v2.6.2 行首删除键统一规则：标题行按标题语义，普通行按层级语义 */
  function deleteBackwardAtStart(row, el) {
    const isH1 = row.textType === 'heading1';
    const isH2 = row.textType === 'heading2';
    const hasCk = row.hasCheckbox !== false;
    const finish = () => { syncTarget(); emit(); restoreCaret(row.key, 0); };
    if (isH2 && hasCk) { row.hasCheckbox = false; row.completed = false; rerenderRowChrome(row.key); finish(); toast('已删除圆圈（仍是二级标题）'); return true; }
    if (isH2 && !hasCk) { row.textType = 'heading1'; row.level = 1; row.parentId = ''; row.hasCheckbox = false; row.completed = false; row.countInProgress = false; rerenderRowChrome(row.key); finish(); toast('已变为一级标题'); return true; }
    if (isH1 && hasCk) { row.hasCheckbox = false; row.completed = false; rerenderRowChrome(row.key); finish(); toast('已删除勾选框（仍是一级标题）'); return true; }
    // v2.6.5 重点：一级标题无框 + 行首删除 = 受控合并到上一条（不删自己前先降级、不依赖浏览器默认合并）
    if (isH1 && !hasCk) { mergeIntoPrevious(row); return true; }
    if (!isH1 && !isH2) {
      if (hasCk) {
        if (row.level === 2) { row.level = 1; row.parentId = ''; rerenderRowChrome(row.key); finish(); toast('已提升为一级（方形勾选框）；行首再按删除键去掉勾选框'); }
        else { row.hasCheckbox = false; row.completed = false; row.countInProgress = false; rerenderRowChrome(row.key); finish(); toast('已删除勾选框（文字保留）'); }
        return true;
      }
      const hasText = row.segs.some((sg) => (sg.t || '').trim()) || String(row.plain || '').trim();
      if (hasText) {
        console.log('[TaskDeleteBackward] normal task has text, do not delete task:', row.key);
        return true; // 拦截：有文字的无框行不允许 Backspace 删整条/误合并
      }
      const idx = rowIdx(row.key);
      rows.splice(idx, 1);
      if (!rows.length) rows.push(newRow(null, 0));
      if (activeRowKey === row.key) activeRowKey = '';
      sel = null;
      renderRows();
      syncTarget();
      emit();
      toast('已删除空文本行');
      return true;
    }
    return false;
  }

  function handleDeleteBackward(el, source) {
    const row = rowByKey(el.dataset.key);
    if (!row) return false;
    if (composing) return false; // 输入法组合中不误触
    const off = caretOffset(el);
    if (off !== 0) return false;
    console.log('[TaskDeleteBackward]', source, row.key, 'textType:', row.textType, 'level:', row.level, 'hasCheckbox:', row.hasCheckbox);
    if (dupDeleteLocked(row.key)) return true; // 另一通道 80ms 内已处理
    return deleteBackwardAtStart(row, el);
  }
  rowsEl.addEventListener('beforeinput', (e) => {
    if (!e.inputType || e.inputType !== 'deleteContentBackward') return;
    const el = e.target && e.target.closest ? e.target.closest('.task-content') : null;
    if (!el) return;
    if (handleDeleteBackward(el, 'beforeinput')) e.preventDefault();
  });

  rowsEl.addEventListener('keydown', (e) => {
    const el = e.target.closest && e.target.closest('.task-content');
    if (!el) return;
    const key = el.dataset.key;
    const row = rowByKey(key);
    if (!row) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      row.segs = parseRowEl(el); // 先固化当前行输入
      if (rows.length >= 50) { toast('一张纸最多 50 行'); return; }
      const atEnd = caretAtEnd(el);
      let nr;
      if (row.textType === 'heading1' && atEnd) {
        // 一级标题末尾换行 → 新建二级标题
        nr = newRow({ id: uid('t'), hasCheckbox: row.hasCheckbox !== false, completed: false, level: 2, parentId: row.id, textType: 'heading2', countInProgress: false }, rows.length);
      } else if (row.textType === 'heading2' && atEnd) {
        // 二级标题末尾换行 → 再建一个二级标题
        nr = newRow({ id: uid('t'), hasCheckbox: row.hasCheckbox !== false, completed: false, level: 2, parentId: row.parentId || '', textType: 'heading2', countInProgress: false }, rows.length);
      } else {
        let parentId = '';
        if (row.level === 2) {
          parentId = row.parentId || '';
          if (!parentId) {
            const idx = rowIdx(key);
            for (let i = idx - 1; i >= 0; i--) {
              if ((rows[i].level || 1) === 1) { parentId = rows[i].id; break; }
            }
          }
        } else {
          parentId = row.id;
        }
        nr = newRow(parentId
          ? { id: uid('t'), hasCheckbox: true, level: 2, parentId }
          : { id: uid('t'), hasCheckbox: true, level: 1 }, rows.length);
      }
      rows.splice(rowIdx(key) + 1, 0, nr);
      activeRowKey = nr.key;
      sel = null;
      renderRows();
      syncTarget();
      emit();
      const nEl = elByKey(nr.key);
      if (nEl) nEl.focus();
    } else if (e.key === 'Backspace') {
      if (handleDeleteBackward(el, 'keydown')) e.preventDefault();
    } else if (e.key === 'Delete') {
      // 选中行内文字时按 Delete：只删该行的勾选控件，不删文字
      const s2 = window.getSelection();
      if (s2 && !s2.isCollapsed && row.hasCheckbox !== false) {
        e.preventDefault();
        row.hasCheckbox = false;
        row.completed = false;
        rerenderRow(key, null);
        syncTarget();
        emit();
        toast(row.level === 2 ? '已删除圆圈（文字保留）' : '已删除勾选框（文字保留）');
      }
    }
  });

  // 一级按钮 → 展开/收起对应二级面板
  function togglePan(id) {
    console.log('[Toolbar] clicked panel:', id);
    const target = mount.querySelector('#pe-pan-' + id);
    const isOpen = target && !target.hidden;
    mount.querySelectorAll('.tool-pan').forEach((p) => { p.hidden = true; });
    mount.querySelectorAll('.tool-btn.l1').forEach((b) => b.classList.remove('on'));
    if (!isOpen && target) {
      target.hidden = false;
      const btn = mount.querySelector(`.tool-btn.l1[data-pan="${id}"]`);
      if (btn) btn.classList.add('on');
    }
  }

  /* ---- v2.6 标题类型 / 勾选控件开关（作用于当前行或选区所在行，操作后编辑栏保持打开） ---- */
  function currentRow() {
    if (sel) return rowByKey(sel.key);
    if (activeRowKey && !titleFocused) return rowByKey(activeRowKey);
    return null;
  }
  function applyTextType(tt) {
    const row = currentRow();
    if (!row) { toast('请先点一条任务再设置标题'); return; }
    row.textType = tt;
    row.countInProgress = tt === 'normal' ? undefined : false;
    rerenderRowChrome(row.key); // 不碰输入区 DOM → 键盘不跳
    syncTarget();
    emit();
  }
  function toggleCheckLevel(level) {
    const row = currentRow();
    if (!row) { toast('请先点一条任务再操作勾选控件'); return; }
    const isHead = row.textType === 'heading1' || row.textType === 'heading2';
    if (level === 1) {
      if (row.level === 1 && row.hasCheckbox !== false) {
        row.hasCheckbox = false; row.completed = false; row.parentId = '';
      } else {
        row.hasCheckbox = true; row.completed = false; row.level = 1; row.parentId = '';
        row.countInProgress = isHead ? false : undefined;
      }
    } else {
      if (row.level === 2 && row.hasCheckbox !== false) {
        row.hasCheckbox = false; row.completed = false; // 保留二级缩进
      } else {
        row.hasCheckbox = true; row.completed = false; row.level = 2;
        if (!row.parentId) {
          const idx = rowIdx(row.key);
          for (let i = idx - 1; i >= 0; i--) { if ((rows[i].level || 1) === 1) { row.parentId = rows[i].id; break; } }
        }
        row.countInProgress = isHead ? false : undefined;
      }
    }
    rerenderRowChrome(row.key); // 不重建输入区 → 输入法保持打开
    syncTarget();
    emit();
  }

  // 工具面板 + 浮动条的事件委托（data-pan / data-fmt / data-size / data-c / data-bg / data-clear / data-tt / data-ck）
  function onToolClick(e) {
    const d = e.target.dataset;
    if (!d) return;
    if (d.tt) { applyTextType(d.tt); e.preventDefault(); return; }
    if (d.ck) { toggleCheckLevel(Number(d.ck)); e.preventDefault(); return; }
    if (d.pan) { togglePan(d.pan); e.preventDefault(); return; }
    if (d.fmt === 'b') toggleField('b');
    else if (d.fmt === 'i') toggleField('i');
    else if (d.fmt === 's') toggleField('s');
    else if (d.fmt === 'u') cycleU();
    else if (d.size !== undefined && d.size !== '') setSize(Number(d.size));
    else if (d.c !== undefined) setColor('c', d.c);
    else if (d.bg !== undefined) setColor('bg', d.bg);
    else if (d.clear) clearFormat();
    else return;
    e.preventDefault();
  }
  $('#pe-tools').addEventListener('click', onToolClick);

  const hexc = $('#pe-hexc');
  const hexbg = $('#pe-hexbg');
  const commitHex = (input, field) => () => {
    const v = input.value.trim();
    if (!v) return;
    setColor(field, v);
    input.value = '';
  };
  hexc.addEventListener('change', commitHex(hexc, 'c'));
  hexc.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitHex(hexc, 'c')(); hexc.blur(); } });
  hexbg.addEventListener('change', commitHex(hexbg, 'bg'));
  hexbg.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitHex(hexbg, 'bg')(); hexbg.blur(); } });

  $('#pe-clear').addEventListener('click', clearFormat);

  /* ---- v2.4 工具卡自动显隐：点进 task 出现，失焦 180ms 后收起 ---- */
  let hideTimer = 0;
  // 编辑栏放到当前正在编辑的 task 正下方（不悬浮遮挡）
  function placeToolsAfterActive() {
    const t = $('#pe-tools');
    if (!t) return;
    const row = rowsEl.querySelector('.task-row.active') || rowsEl.querySelector('.task-row:last-child');
    if (row && row.nextElementSibling !== t) row.insertAdjacentElement('afterend', t);
  }
  function showTools() {
    clearTimeout(hideTimer);
    const t = $('#pe-tools');
    if (t && !readonly) {
      placeToolsAfterActive();
      t.classList.remove('is-hidden');
    }
  }
  function scheduleHideTools() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const t = $('#pe-tools');
      if (t) t.classList.add('is-hidden');
    }, 180);
  }
  function openTextToolbarForKey(key) {
    if (!key) return;
    activeRowKey = key;
    titleFocused = false;
    rowsEl.querySelectorAll('.task-row').forEach((tr) => tr.classList.toggle('active', tr.dataset.key === key));
    placeToolsAfterActive();
    showTools();
    syncTarget();
  }
  // v2.6.2：pointerdown / touchstart / click / focusin 四通道兜底，确保点文字必弹编辑栏
  ['pointerdown', 'touchstart', 'click'].forEach((evName) => {
    mount.addEventListener(evName, (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('.pcheck')) return; // 勾选框：只切换完成，不弹栏
      const content = t.closest('.task-content');
      if (content && content.dataset.key) openTextToolbarForKey(content.dataset.key);
    }, { passive: true });
  });
  mount.addEventListener('focusin', (e) => {
    if (e.target.closest && e.target.closest('#pe-rows, #pe-title, #pe-tools')) {
      showTools();
      // 保证当前 task 不被键盘/编辑栏挡住
      setTimeout(() => {
        const row = rowsEl.querySelector('.task-row.active');
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 120);
    }
  });
  // v2.4.1：blur 不再自动收起（选色号/字号会触发 blur，导致编辑栏闪退）
  // 收起只由：关闭按钮 / 点击编辑栏与任务区之外的空白 / 页面切换（编辑器销毁）触发
  function hideToolsNow() {
    clearTimeout(hideTimer);
    const t = $('#pe-tools');
    if (t) t.classList.add('is-hidden');
    mount.querySelectorAll('.tool-pan').forEach((p) => { p.hidden = true; });
    mount.querySelectorAll('.tool-btn.l1').forEach((b) => b.classList.remove('on'));
  }
  const onClose = () => hideToolsNow();
  const closeBtn = $('#pe-close');
  if (closeBtn) closeBtn.addEventListener('click', onClose);
  // 点工具栏内部不丢焦点/选区，也不触发外部关闭
  const toolsEl = $('#pe-tools');
  if (toolsEl) {
    toolsEl.addEventListener('mousedown', (e) => e.preventDefault());
    toolsEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    toolsEl.addEventListener('click', (e) => e.stopPropagation());
  }
  const onDocPointerDown = (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#pe-tools') || t.closest('#pe-rows') || t.closest('#pe-title')) return;
    hideToolsNow();
  };
  document.addEventListener('pointerdown', onDocPointerDown);

  document.addEventListener('selectionchange', onSelectionChange);

  renderRows();
  syncTarget();

  /* ---------- 对外 ---------- */
  return {
    getPayload,
    setPaperAppearance(paperClass) {
      const paper = $('#pe-paper');
      paper.className = 'paper ' + (paperClass || '');
    },
    togglePan,
    addRow: addRowAt,
    destroy() {
      destroyed = true;
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onDocPointerDown);
      mount.innerHTML = '';
    }
  };
}

let paper_toast = null; // 供内部引用占位（无副作用）
