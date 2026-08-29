# 星慕畅玩 · Steam 账号共享站

公益 Steam 离线账号分享站（极简重做版）。前端纯 vanilla HTML/CSS/JS，后端跑在 Cloudflare Workers 上，数据存 D1 + KV，邮箱验证码走 Resend。

## 技术栈

| 部分 | 技术 |
|------|------|
| 前端 | 原生 HTML / CSS / JavaScript（无框架） |
| 后端 | Cloudflare Worker（JavaScript） |
| 主数据库 | Cloudflare D1（用户 / 游戏 / 账号 / 提交 / 配额） |
| 临时数据 | Cloudflare KV（邮箱验证码 / 登录会话） |
| 邮件 | Resend（免费 3000 封/月） |
| 人机验证 | Cloudflare Turnstile（**待你提供接入代码与 API 后植入**） |

## 目录结构

```
steam-share/
├── worker/
│   ├── src/index.js      # Worker 后端（全部 API）
│   ├── schema.sql        # D1 建表语句
│   └── wrangler.toml     # 部署配置
├── public/               # 前端静态资产（后续开发）
└── README.md
```

## 核心规则（均可在文件里改）

- **账号**：无密码体系，用「邮箱验证码」注册 / 登录；登录时若邮箱未注册会自动建号。
- **领取**：每日免费 N 次（默认 `DAILY_QUOTA=1`），共享账号池；每次领取随机看到 1 个号，账号不消耗，想再看需再耗 1 次额度。
- **提交**：用户提交游戏（标题 + 账号 + 密码）→ 管理员审核通过 → 自动上架 + 提交者获得 VIP。
- **管理员**：环境变量 `ADMIN_EMAIL` 指定的邮箱，首次部署自动建管理员账号；用该邮箱验证码登录后即为管理员。

## 部署步骤

### 0. 装 wrangler（首次）

```bash
npm install -g wrangler
wrangler login
```

### 1. 创建 D1 数据库，拿到 database_id

```bash
cd steam-share/worker
wrangler d1 create steam-share-db
```

把输出里的 `database_id` 填进 `wrangler.toml`。

### 2. 创建 KV 命名空间，拿到 id

```bash
wrangler kv namespace create SESSION_KV
```

把输出里的 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]].id`。

### 3. 初始化数据表

```bash
wrangler d1 execute steam-share-db --file=./schema.sql --remote
```

### 4. 配置环境变量

编辑 `wrangler.toml` 的 `[vars]`：

```toml
ADMIN_EMAIL = "你的管理员邮箱@example.com"
DAILY_QUOTA = "1"
SESSION_TTL_DAYS = "30"
```

### 5. 设置密钥（发信）

```bash
wrangler secret put RESEND_API_KEY   # 粘贴 Resend 的 API Key
wrangler secret put EMAIL_FROM       # 发件人，如：星慕畅玩 <no-reply@你的域名>
```

> Resend 免费版需先在 Resend 后台验证你的发信域名（或直接用其测试域名 onboarding@resend.dev）。

### 6. 改 wrangler.toml 里两处 REPLACE 占位后部署

```bash
wrangler deploy
```

## API 接口一览

| 方法 | 路径 | 说明 | 登录 |
|------|------|------|------|
| POST | `/api/auth/send-code` | 发送邮箱验证码 `{email, mode}` | 否 |
| POST | `/api/auth/register` | 注册 `{email, code, username}` | 否 |
| POST | `/api/auth/login` | 登录 `{email, code}`（未注册自动建号） | 否 |
| POST | `/api/auth/logout` | 退出登录 | 是 |
| GET | `/api/auth/me` | 当前用户 + 配额 | 是 |
| GET | `/api/games` | 游戏列表 | 否 |
| POST | `/api/account` | 领取账号 `{gameId}`（扣 1 次额度） | 是 |
| POST | `/api/submit` | 提交游戏 `{title, category, account, password}` | 是 |
| GET | `/api/admin/data` | 后台概览（游戏/账号/待审核/用户数） | 管理员 |
| POST | `/api/admin/review` | 审核提交 `{id, approved}` | 管理员 |
| POST | `/api/admin/game` | 新增/修改游戏 | 管理员 |
| POST | `/api/admin/game/delete` | 删除游戏（连带账号） | 管理员 |
| POST | `/api/admin/account` | 给游戏添加账号 | 管理员 |
| POST | `/api/admin/account/delete` | 删除账号 | 管理员 |

**鉴权方式**：登录/注册成功后返回 `token`，前端请求在请求头带 `Authorization: Bearer <token>`。

## 待接入（TODO）

1. **Cloudflare Turnstile**：人机验证。接入代码和 API 由你提供，我后续植入（`index.js` 内 `apiSendCode` 已留校验位）。
2. **GitHub OAuth 登录**：整体框架做完后再接入。
3. **VIP 权益**：当前 VIP 只是标记，具体权益（如更高额度）等你确定后加。
4. **前端页面**：`public/` 目录尚未开发。