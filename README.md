# 一起 To Do · 网页版（PWA）

与微信小程序端功能一致的第二端。**小程序端（`../miniprogram/`、`../cloudfunctions/`）保持不动**，本目录是纯新增。

## 技术选型说明

需求建议 React/Vite 或 Vue/Vite。考虑到本项目现状（无任何 Web 构建链、微信云开发后端无法被浏览器直接调用），网页版采用**零构建原生 ES Modules + IndexedDB + 手写 PWA**：

- 不需要 npm install / 打包，任何静态服务器直接可跑，避免构建链在沙箱与本机环境的不可控问题；
- 数据模型、富文本片段（`rich` segs）、勾选框规则、筛选规则、模板体系与小程序端**完全一致**（`js/util.js` 是两端同规则的实现），未来接入同一后端时只需替换 `js/db.js`；
- 如后续坚持 React/Vite，`js/util.js`、`js/db.js` 的逻辑可原样迁入。

## 运行

```bash
cd web
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

任意静态服务器均可（nginx、`npx serve` 等）。**不要用 file:// 直接打开**（Service Worker 需要 http(s)）。

## 安装到手机桌面（PWA）

1. 将 `web/` 部署到任意可访问的 HTTPS 地址（PWA 安装要求 HTTPS，本机 localhost 调试除外）；
2. Android Chrome：菜单 →「添加到主屏幕 / 安装应用」；
3. iOS Safari：分享 →「添加到主屏幕」；
4. 安装后 `display: standalone` 全屏运行，断网可打开（Service Worker 预缓存全部静态资源），数据在本机 IndexedDB 中离线可读写。

## 目录

```
web/
├── index.html            # 应用壳（tabbar / topbar / 离线横幅）
├── manifest.webmanifest  # PWA 清单（standalone、主题色 #7fcf91、图标）
├── sw.js                 # Service Worker：预缓存 + 导航离线回退
├── icons/                # 192 / 512 图标
├── css/app.css           # 嫩绿主题；移动优先，≥860px 编辑工具移到右侧栏
└── js/
    ├── util.js           # 公共业务逻辑（标题/进度/筛选/富文本/模板/分类，与小程序同规则）
    ├── db.js             # IndexedDB：TodoRepository / GroupRepository / 导入导出
    ├── paper.js          # 纸张编辑器：标题 + Task List + 选区 + 编辑工具模块 + 浮动格式条
    └── app.js            # hash 路由 + 今日 / 专题 / 编辑 / 群组 / 我的
```

## 与小程序端的功能对照

| 功能 | 小程序 | 网页版 |
|---|---|---|
| 每日 Todo（单日聚焦 ‹ › / 选日 / 回到今天 / 进度卡 / 筛选 chips） | ✅ 云开发 | ✅ IndexedDB |
| 分类专题（月 / 日 / 类别 / 关键词 / 重置；无开始结束日，仅自动记录创建与修改时间） | ✅ | ✅ |
| 整篇标题（一篇一个、位于 Task List 上方、默认黑粗大、可改文本与格式、titleStyle 存库） | ✅ | ✅ |
| Task List（增删改、勾选、hasCheckbox 可加可删、无框不参与统计） | ✅ | ✅ |
| 富文本（先输入 → 选中 → 套格式：B/I/U/S/字号/字色/背景色/色号输入/清除格式） | ✅ 点字选区 | ✅ 原生拖选 + 浮动条 + 编辑工具模块 |
| 编辑工具模块（集中管理，不散落在每条 task 后） | ✅ 纸张下方 | ✅ 移动端纸张下方 / 桌面端右侧栏 |
| 模板（12 种）/ 纸张底纹 | ✅ | ✅（CSS 底纹等价实现） |
| 首页卡片只显示标题（≤24 截断，旧数据回落首个非空 task，无分类不显示「未分类」） | ✅ | ✅ |
| 进度条只统计带 checkbox 的 task | ✅ | ✅ |
| 共享 / 群组（isShared / groupId / ownerId / lastEditedBy 字段保留） | ✅ 真实云同步 | ⚠️ 本地演示（字段完整，待接后端） |
| 点赞 / 评论（依赖微信身份与云函数事务） | ✅ | ❌ 不在网页版范围 |

数据存储字段两端一致：`title / titleCustom / titleStyle / moduleType / categoryId / categoryName / targetDate / tasks[{id,text,completed,hasCheckbox,rich}] / templateId / isShared / groupId / ownerId / lastEditedBy / isDone / createTime / updateTime`（`createdAt/updatedAt` 即 `createTime/updateTime` 毫秒时间戳）。

富文本不保存 HTML 源码（无 `task.html/titleHtml` 落库），渲染时由白名单样式字段生成 CSS，用户文本一律经 text 节点/转义输出，天然防 script 注入。
