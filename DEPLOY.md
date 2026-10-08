# AI 新闻背单词 · 部署指南

## 快速部署

### 方式一：Netlify（最简单，拖拽即可）

1. 注册 Netlify 账号（netlify.com，支持 GitHub 登录）
2. 进入 Dashboard，点击 "Add new site" → "Deploy manually"
3. 把整个项目文件夹拖拽到上传区域
4. 等几秒就部署好了，会给你一个 xxx.netlify.app 的域名

### 方式二：Vercel（推荐，速度快）

1. 注册 Vercel 账号（vercel.com，支持 GitHub 登录）
2. 点击 "Add New..." → "Project"
3. 选择 "Import Third-Party Git Repository" 或直接用 CLI
4. 框架预设选 "Other"，构建命令留空，输出目录填 "."
5. 部署完成，得到 xxx.vercel.app 域名

### 方式三：GitHub Pages

1. 把项目推到 GitHub 仓库
2. 仓库 Settings → Pages
3. Source 选 main 分支 / root 目录
4. 等几分钟，访问 username.github.io/repo-name/

## 手机添加到主屏幕

### iOS（Safari）

1. 用 Safari 打开网站
2. 点击底部分享按钮（方框+箭头）
3. 往下滑，找到「添加到主屏幕」
4. 改个名字，点「添加」
5. 桌面就有图标了，点开像原生 App 一样全屏

### Android（Chrome）

1. 用 Chrome 打开网站
2. 点击右上角三个点
3. 选择「添加到主屏幕」或「安装应用」
4. 确认后桌面就有图标了

## 注意事项

### AI 功能说明

本项目 MVP 阶段的 AI 新闻生成依赖本地 Python 代理（proxy_server.py），
部署到线上后，AI 生成功能将不可用。

可用的功能：
- ✅ 单词量测试
- ✅ 单词本管理
- ✅ 间隔重复复习
- ✅ 查看已缓存的新闻和单词
- ❌ 实时生成新新闻（需要本地代理）

如果需要在线 AI 功能，后续可以：
1. 接入云函数（Vercel Functions / Netlify Functions）
2. 把 API Key 存在服务端环境变量里
3. 前端调用云函数，云函数再转发给 AI 接口

### 安全提醒

⚠️ 不要把 API Key 直接提交到公开仓库！
当前 MVP 阶段 Key 存在前端代码中，仅限个人学习使用。
如果要部署到公开地址，建议先移除 Key 或接入后端代理。

## 本地开发

双击「启动本地服务器.bat」即可同时启动：
- 网页服务（http://127.0.0.1:8080）
- AI 代理（http://127.0.0.1:8787）
