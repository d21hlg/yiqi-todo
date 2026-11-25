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
  const onChange = opts.onChange || (() => {});
  const rows = (opts.initial && opts.initial.tasks && opts.initial.tasks.length
    ? opts.initial.tasks : [null]).map((t, i) => newRow(t, i));
  let titleVal = (opts.initial && opts.initial.title) || '';
  let titleSt = normalizeTitleStyle(opts.initial && opts.initial.titleStyle);
  let activeRowKey = '';
  let titleFocused = false;
  let sel = null; // { key, start, end }
  let destroyed = false;

  /* ---------- 骨架 ---------- */
  mount.innerHTML = `
    <div class="paper ${esc(opts.paperClass || '')}" id="pe-paper">
      <input class="todo-title-input" id="pe-title" value="${esc(titleVal)}" placeholder="请输入标题" maxlength="80" />
      <div class="todo-title-divider"></div>
      <div id="pe-rows"></div>
      <div class="paper-add" id="pe-add">＋ 添加任务</div>
    </div>
    <div class="card tools-card" id="pe-tools">
      <div class="tools-head">
        <span class="tools-title">编辑工具</span>
        <span class="t-mut" id="pe-target">当前选中：未选择</span>
      </div>
      <div class="tool-sec">
        <span class="lbl">勾选框</span>
        <button class="tool-btn" id="pe-ckbtn" disabled>删除勾选框</button>
        <span class="t-mut" id="pe-ckhint">请先选择一行内容</span>
      </div>
      <div class="tool-sec">
        <span class="lbl">文字格式</span>
        <span class="tool chip-b" data-fmt="b">B</span>
        <span class="tool chip-i" data-fmt="i">I</span>
        <span class="tool chip-u" data-fmt="u">U</span>
        <span class="tool chip-s" data-fmt="s">S</span>
      </div>
      <div class="tool-sec">
        <span class="lbl">字号</span>
        <span class="tool" data-size="0">标准</span>
        <span class="tool" data-size="1">小</span>
        <span class="tool" data-size="2">大</span>
      </div>
      <div class="tool-sec">
        <span class="lbl">文字颜色</span>
        <span class="dot none" data-c=""></span>
        ${COLORS.map((c) => `<span class="dot" data-c="${c.accent}" style="background:${c.accent}" title="${c.name}"></span>`).join('')}
        <input class="hex-input" id="pe-hexc" placeholder="#7fcf91" maxlength="7" />
      </div>
      <div class="tool-sec">
        <span class="lbl">背景色</span>
        <span class="dot none" data-bg=""></span>
        ${COLORS.map((c) => `<span class="dot" data-bg="${c.soft}" style="background:${c.soft}" title="${c.name}"></span>`).join('')}
        <input class="hex-input" id="pe-hexbg" placeholder="#f8e7a1" maxlength="7" />
      </div>
      <div class="tool-sec">
        <span class="tool danger" id="pe-clear">清除格式</span>
      </div>
    </div>`;

  // 浮动格式条（选中文字后出现，移动端友好）
  const floatBar = document.createElement('div');
  floatBar.className = 'float-bar';
  floatBar.innerHTML = `
    <span class="fb" data-fmt="b"><b>B</b></span>
    <span class="fb" data-fmt="i"><i>I</i></span>
    <span class="fb" data-fmt="u"><u>U</u></span>
    <span class="fb" data-fmt="s"><s>S</s></span>
    <span class="fb" data-size="1">小</span>
    <span class="fb" data-size="2">大</span>
    ${COLORS.slice(0, 6).map((c) => `<span class="fb" data-c="${c.accent}" style="color:${c.accent}">●</span>`).join('')}
    <span class="fb" data-clear="1">清除</span>`;
  document.body.appendChild(floatBar);

  const $ = (sel2) => mount.querySelector(sel2);
  const rowsEl = $('#pe-rows');
  const titleEl = $('#pe-title');
  const targetEl = $('#pe-target');
  const ckBtn = $('#pe-ckbtn');
  const ckHint = $('#pe-ckhint');

  titleEl.style.cssText = titleStyleCss(titleSt);

  /* ---------- 渲染 ---------- */
  function renderRows() {
    rowsEl.innerHTML = rows.map((r) => {
      const done = r.hasCheckbox && r.completed;
      const check = r.hasCheckbox
        ? `<span class="pcheck ${done ? 'on' : ''}" data-act="check" data-key="${r.key}"></span>`
        : `<span class="pcheck-ghost" data-act="activate" data-key="${r.key}" title="纯文本行（无勾选框，不参与完成统计）"></span>`;
      return `<div class="task-row ${activeRowKey === r.key ? 'active' : ''}" data-key="${r.key}">
        ${check}
        <div class="task-content ${done ? 'done' : ''}" contenteditable="true" spellcheck="false"
          data-ph="写一条任务…" data-key="${r.key}">${segsToHtml(r.segs, done)}</div>
        <span class="task-del" data-act="del" data-key="${r.key}">⋯</span>
      </div>`;
    }).join('');
  }

  function rowByKey(key) { return rows.find((r) => r.key === key); }
  function rowIdx(key) { return rows.findIndex((r) => r.key === key); }
  function elByKey(key) { return rowsEl.querySelector(`.task-content[data-key="${key}"]`); }

  function syncTarget() {
    let label = '未选择';
    if (titleFocused) label = '标题';
    else if (sel) label = `第 ${rowIdx(sel.key) + 1} 行 · 已选中文字`;
    else if (activeRowKey) label = `第 ${rowIdx(activeRowKey) + 1} 行`;
    targetEl.textContent = '当前选中：' + label;
    const row = activeRowKey ? rowByKey(activeRowKey) : null;
    if (row && !titleFocused) {
      ckBtn.disabled = false;
      ckHint.style.display = 'none';
      ckBtn.textContent = row.hasCheckbox ? '删除勾选框' : '添加勾选框';
    } else {
      ckBtn.disabled = true;
      ckBtn.textContent = titleFocused ? '添加/删除勾选框' : '添加勾选框 / 删除勾选框';
      ckHint.style.display = '';
    }
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
          hasCheckbox: r.hasCheckbox
        };
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
    const chk = el.parentNode.querySelector('.pcheck, .pcheck-ghost');
    if (chk) {
      chk.className = row.hasCheckbox ? `pcheck ${done ? 'on' : ''}` : 'pcheck-ghost';
    }
    if (caretOffset != null) setCaret(el, caretOffset);
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
    syncTarget();
  });
  rowsEl.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    const key = e.target.dataset && e.target.dataset.key;
    if (!act || !key) return;
    const row = rowByKey(key);
    if (!row) return;
    if (act === 'check') {
      if (!row.hasCheckbox) return;
      row.completed = !row.completed;
      rerenderRow(key, null);
      elByKey(key) && elByKey(key).focus();
      emit();
    } else if (act === 'activate') {
      activeRowKey = key;
      titleFocused = false;
      elByKey(key) && elByKey(key).focus();
      syncTarget();
    } else if (act === 'del') {
      if (!window.confirm('删除这条任务？删除后可在保存前刷新页面恢复。')) return;
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

  $('#pe-add').addEventListener('click', () => {
    if (rows.length >= 50) { toast('一张纸最多 50 行'); return; }
    const r = newRow(null, rows.length);
    rows.push(r);
    renderRows();
    activeRowKey = r.key;
    syncTarget();
    const el = elByKey(r.key);
    if (el) el.focus();
    emit();
  });

  ckBtn.addEventListener('click', () => {
    if (!activeRowKey || titleFocused) { toast('请先选择一行内容'); return; }
    const row = rowByKey(activeRowKey);
    if (!row) return;
    row.hasCheckbox = row.hasCheckbox === false; // 有→删；无→加
    row.completed = false;                        // 切换后 completed 一律归 false
    rerenderRow(row.key, null);
    syncTarget();
    emit();
    toast(row.hasCheckbox ? '已添加勾选框' : '已改为纯文本行（不参与完成统计）');
  });

  // 工具面板 + 浮动条的事件委托（data-fmt / data-size / data-c / data-bg / data-clear）
  function onToolClick(e) {
    const d = e.target.dataset;
    if (!d) return;
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
  floatBar.addEventListener('mousedown', (e) => e.preventDefault()); // 防止点浮动条丢选区
  floatBar.addEventListener('click', onToolClick);

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
    destroy() {
      destroyed = true;
      document.removeEventListener('selectionchange', onSelectionChange);
      floatBar.remove();
      mount.innerHTML = '';
    }
  };
}

let paper_toast = null; // 供内部引用占位（无副作用）
