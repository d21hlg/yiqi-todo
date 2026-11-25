/* Supabase 云同步开关与凭据（P1/P2）
 * 已填好：项目 lyilzyekqfawrhorjgoq（Free 档，Region 由 Owner 选定）。
 * USE_SUPABASE 自动为 true；如需临时关闭：浏览器控制台执行
 *   localStorage.setItem('yiqi-supabase-off','1') 后刷新；恢复则 removeItem 后刷新。
 * anon/publishable key 是公开发前端的安全密钥，权限由数据库 RLS 策略保护。
 */
export const SUPABASE_URL = 'https://lyilzyekqfawrhorjgoq.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_96K4NFi7IZ9At41E7Msfag_2Puc8ar6';
export const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_ANON_KEY) && localStorage.getItem('yiqi-supabase-off') !== '1';
