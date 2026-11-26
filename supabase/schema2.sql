-- ============================================================================
-- 一起ToDo · Supabase Schema（增量 v2.3：群组 + 共享协同 + 置顶）
-- 在 Supabase Dashboard → SQL Editor 执行一次（幂等，可重复执行）
-- 前提：已执行过 schema1.sql（profiles / todos / 部分唯一索引）
-- 执行后务必到 API Keys 页点一次 Rotate（沿用 v2.2 安全建议）
-- =============================================
alter table public.todos add column if not exists is_pinned boolean not null default false;
alter table public.todos add column if not exists pinned_at text not null default '';

-- ---------- 群组 ----------
create table if not exists public.groups (
  id          text primary key,
  name        text not null default '',
  invite_code text not null,
  owner_id    uuid not null references auth.users(id) on delete cascade,
  created_at  bigint not null default (floor(extract(epoch from now()) * 1000))
);
create unique index if not exists uq_groups_invite_code on public.groups (upper(invite_code));

create table if not exists public.group_members (
  group_id  text not null references public.groups(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'member',   -- owner | member
  status    text not null default 'active',   -- active | removed
  joined_at bigint not null default (floor(extract(epoch from now()) * 1000)),
  primary key (group_id, user_id)
);
create index if not exists ix_gm_user on public.group_members (user_id, status);

alter table public.groups enable row level security;
alter table public.group_members enable row level security;

-- 我能看到的群 = 我创建的 + 我是活跃成员的
drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups for select using (
  owner_id = auth.uid()
  or exists (select 1 from public.group_members gm
             where gm.group_id = groups.id and gm.user_id = auth.uid() and gm.status = 'active')
);
-- 任何人都能创建自己的群（owner 必须是自己）
drop policy if exists groups_insert on public.groups;
create policy groups_insert on public.groups for insert with check (owner_id = auth.uid());
-- 仅创建者可改名/换邀请码/删除
drop policy if exists groups_update on public.groups;
create policy groups_update on public.groups for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists groups_delete on public.groups;
create policy groups_delete on public.groups for delete using (owner_id = auth.uid());

-- 成员表：本群成员或群主可见（加入前 findByCode 查的是 groups 表，不查成员）
drop policy if exists gm_select on public.group_members;
create policy gm_select on public.group_members for select using (
  user_id = auth.uid()
  or group_id in (select g.id from public.groups g where g.owner_id = auth.uid())
);
-- 任何登录用户可以把自己加入任意群（= 凭邀请码加入）
drop policy if exists gm_insert on public.group_members;
create policy gm_insert on public.group_members for insert with check (user_id = auth.uid());
drop policy if exists gm_update on public.group_members;
create policy gm_update on public.group_members for update using (
  user_id = auth.uid()
  or group_id in (select g.id from public.groups g where g.owner_id = auth.uid())
);
drop policy if exists gm_delete on public.group_members;
create policy gm_delete on public.group_members for delete using (
  user_id = auth.uid()
  or group_id in (select g.id from public.groups g where g.owner_id = auth.uid())
);

-- ---------- todos：共享协同策略（替换 schema1 的「仅本人」策略） ----------
-- 可见 = 我创建的 或（已共享且我属于它的群）
drop policy if exists todos_all_own on public.todos;
drop policy if exists todos_select on public.todos;
create policy todos_select on public.todos for select using (
  owner_id = auth.uid()
  or (is_shared and group_id::text in (select group_id from public.group_members
                                 where user_id = auth.uid() and status = 'active'))
);
drop policy if exists todos_insert on public.todos;
create policy todos_insert on public.todos for insert with check (owner_id = auth.uid());
drop policy if exists todos_update on public.todos;
create policy todos_update on public.todos for update using (
  owner_id = auth.uid()
  or (is_shared and group_id::text in (select group_id from public.group_members
                                 where user_id = auth.uid() and status = 'active'))
) with check (
  owner_id = auth.uid()
  or (is_shared and group_id::text in (select group_id from public.group_members
                                 where user_id = auth.uid() and status = 'active'))
);
drop policy if exists todos_delete on public.todos;
create policy todos_delete on public.todos for delete using (owner_id = auth.uid());

-- 列级权限：API 不可改写 owner_id / id / created_at（防冒领），
-- 其余业务列允许更新（成员协同编辑任务/标题/置顶等）
revoke update on table public.todos from anon, authenticated;
grant update (title, title_custom, title_style, module_type, category_id, category_name,
  target_date, tasks, template_id, color_key, is_shared, group_id, is_done, updated_at,
  last_edited_by, last_edited_by_name, is_pinned, pinned_at)
  on table public.todos to anon, authenticated;

-- 新表权限
grant select, insert, update, delete on table public.groups to anon, authenticated;
grant select, insert, update, delete on table public.group_members to anon, authenticated;
