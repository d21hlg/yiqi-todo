/* Supabase 云端适配器（P1/P2）
 * - 仅当 js/config.js 填好 URL + anon key（USE_SUPABASE=true）且已登录时激活；
 * - SDK 通过 CDN ESM 动态 import，未启用时不会下载任何 supabase 资源（零构建不变）；
 * - 对 db.js 暴露与本地仓储同形的 CloudTodoRepository；群组协同为 P3（groups 表 + Realtime）；
 * - 行(row, snake_case) 与 前端文档(doc) 映射集中在 todoToRow / rowToTodo 两个函数。
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, USE_SUPABASE } from './config.js';

let _sb = null;
let _loading = null;
function client() {
  if (_sb) return Promise.resolve(_sb);
  if (!_loading) {
    _loading = import('./supabase-js.js') /* 本地 vendor 副本，零 CDN 依赖 */
      .then((m) => m.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true }
      }))
      .then((c) => { _sb = c; return c; })
      .catch((e) => { _loading = null; throw e; }); /* 失败可重试 */
  }
  return _loading;
}

/* ---------- 会话状态（同步读取；initAuth 维护） ---------- */
const st = { session: null };
export function supaState() {
  return {
    enabled: !!USE_SUPABASE,
    active: !!st.session,
    uid: st.session ? st.session.user.id : '',
    email: st.session ? (st.session.user.email || '') : ''
  };
}

export async function initAuth(onChange) {
  if (!USE_SUPABASE) return;
  try {
    const c = await Promise.race([
      client(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('SDK 加载超时')), 15000))
    ]);
    const { data } = await c.auth.getSession();
    st.session = data.session || null;
    c.auth.onAuthStateChange((event, session) => {
      st.session = session || null;
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED') {
        if (typeof onChange === 'function') onChange();
      }
    });
  } catch (e) {
    console.warn('[supabase] initAuth failed', e);
  }
}

/* ---------- 鉴权：邮箱魔法链接（无密码） ---------- */
export async function signInWithEmail(email, redirectTo) {
  const c = await client();
  const { error } = await c.auth.signInWithOtp({
    email: String(email || '').trim(),
    options: { emailRedirectTo: redirectTo || location.href.split('#')[0] }
  });
  if (error) throw error;
}
export async function signOutCloud() {
  const c = await client();
  await c.auth.signOut();
  st.session = null;
}

/* ---------- 用户档案 profiles（ownerId 迁移为 auth.uid()） ---------- */
async function ensureProfile(c, uid) {
  await c.from('profiles').upsert(
    { id: uid, nickname: '', custom_categories: ['', '', '', '', ''] },
    { onConflict: 'id', ignoreDuplicates: true }
  );
}
export async function getCloudUser() {
  const s = supaState();
  if (!s.active) return null;
  const c = await client();
  await ensureProfile(c, s.uid);
  const { data } = await c.from('profiles').select('*').eq('id', s.uid).maybeSingle();
  const cats = data && Array.isArray(data.custom_categories) && data.custom_categories.length === 5
    ? data.custom_categories : ['', '', '', '', ''];
  return {
    ownerId: s.uid,
    nickName: (data && data.nickname) || (s.email ? s.email.split('@')[0] : '') || '网页用户',
    customCategories: cats
  };
}
export async function saveCloudUser(user) {
  const s = supaState();
  if (!s.active) return;
  const c = await client();
  await ensureProfile(c, s.uid);
  await c.from('profiles').update({
    nickname: user.nickName || '',
    custom_categories: user.customCategories || ['', '', '', '', ''],
    updated_at: Date.now()
  }).eq('id', s.uid);
}

/* ---------- todos：doc <-> row ---------- */
function todoToRow(t, uid) {
  return {
    id: t.id,
    owner_id: uid,
    title: t.title || '',
    title_custom: !!t.titleCustom,
    title_style: t.titleStyle || null,
    module_type: t.moduleType === 'categorized' ? 'categorized' : 'daily',
    category_id: Number(t.categoryId) || 0,
    category_name: t.categoryName || '',
    target_date: t.targetDate || '',
    tasks: t.tasks || [],
    template_id: t.templateId || 'plain-paper',
    color_key: t.colorKey || 'mint',
    is_shared: !!t.isShared,
    group_id: null, /* P3 群组协同启用 */
    share_group_ids: t.shareGroupIds || [],
    is_done: !!t.isDone,
    last_edited_by: t.lastEditedBy || uid,
    last_edited_by_name: t.lastEditedByName || '',
    created_at: Number(t.createTime) || Date.now(),
    updated_at: Number(t.updateTime) || Date.now()
  };
}
function rowToTodo(r) {
  return {
    id: r.id,
    ownerId: r.owner_id,
    title: r.title || '',
    titleCustom: !!r.title_custom,
    titleStyle: r.title_style || null,
    moduleType: r.module_type,
    categoryId: r.category_id,
    categoryName: r.category_name,
    targetDate: r.target_date || '',
    tasks: r.tasks || [],
    templateId: r.template_id,
    colorKey: r.color_key,
    isShared: !!r.is_shared,
    groupId: r.group_id || '',
    shareGroupIds: r.share_group_ids || [],
    isDone: !!r.is_done,
    lastEditedBy: r.last_edited_by || r.owner_id,
    lastEditedByName: r.last_edited_by_name || '',
    createTime: r.created_at,
    updateTime: r.updated_at
  };
}

function needUid() {
  const s = supaState();
  if (!s.active) throw new Error('云端未登录');
  return s.uid;
}

export const CloudTodoRepository = {
  async getTodos() {
    const uid = needUid();
    const c = await client();
    /* RLS 已限定本人数据；显式 eq 双保险 */
    const { data, error } = await c.from('todos').select('*')
      .eq('owner_id', uid).order('updated_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(rowToTodo);
  },
  async getTodoById(id) {
    const uid = needUid();
    const c = await client();
    const { data, error } = await c.from('todos').select('*').eq('id', id).eq('owner_id', uid).maybeSingle();
    if (error) throw error;
    return data ? rowToTodo(data) : null;
  },
  async createTodo(todo) { return this.upsertOne(todo); },
  async updateTodo(todo) { return this.upsertOne(todo); },
  async upsertOne(todo) {
    const uid = needUid();
    const c = await client();
    const { error } = await c.from('todos').upsert(todoToRow(todo, uid), { onConflict: 'id' });
    if (error) throw error;
  },
  /* 批量上云（首次登录迁移本机数据用）；返回成功条数 */
  async upsertMany(list) {
    const uid = needUid();
    const c = await client();
    let n = 0;
    const rows = (list || []).filter((t) => t && t.id).map((t) => todoToRow(t, uid));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await c.from('todos').upsert(rows.slice(i, i + 200), { onConflict: 'id' });
      if (error) throw error;
      n += Math.min(200, rows.length - i);
    }
    return n;
  },
  async deleteTodo(id) {
    needUid();
    const c = await client();
    const { error } = await c.from('todos').delete().eq('id', id);
    if (error) throw error;
  }
};
