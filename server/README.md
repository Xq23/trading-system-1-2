# TS12 API（Railway / 自建 Node）

为静态前端提供：**注册登录**、**币种/分组同步**、**突破扫描结果同步**。

## 本地运行

```bash
cd server
cp .env.example .env
# 编辑 .env：JWT_SECRET、CORS_ORIGINS
npm install
npm run dev
```

健康检查：`http://localhost:8787/health`

## 前端对接

编辑项目根目录 `scripts/ts12-api-config.js`：

```javascript
window.TS12_CONFIG = { apiBase: "http://localhost:8787" };
```

或访问页面时加参数：`login.html?api=http://localhost:8787`

## 部署到 Railway

1. 新建 Project → Deploy from GitHub repo  
2. **Root Directory** 设为 `server`  
3. 环境变量：
   - `JWT_SECRET`：随机长字符串（必填）
   - `CORS_ORIGINS`：前端地址，逗号分隔  
     例：`https://xxx.vercel.app,https://xxx.netlify.app`
   - `DATABASE_PATH`：`/data/ts12.db`（推荐挂载 Volume 到 `/data`）
4. 添加 **Volume**，挂载路径 `/data`  
5. 部署后记下公网 URL，填入前端 `apiBase`

## 部署前端（Vercel / Netlify）

- 发布目录：仓库根目录（含 `overview.html`）  
- 将 `scripts/ts12-api-config.js` 里的 `apiBase` 改为 Railway 地址后一并提交，或在构建脚本中替换

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录，返回 JWT |
| GET | `/api/auth/me` | 当前用户（需 Bearer） |
| GET/PUT | `/api/sync/prefs` | 币种偏好 JSON |
| GET/PUT/DELETE | `/api/sync/break-scan` | 扫描缓存 |

数据存在 SQLite 文件（`DATABASE_PATH`），换机需备份该文件或使用 Volume 持久化。
