# 内部供应链本地沙盒

本模式运行完整的前端和 API，但 API 只能连接本机 `dianjie_v4_local`。页面里的新增、改价、删除、审批、发货和收货等都只修改本地副本。

## 第一次初始化（空白/演示数据）

```bash
export LOCAL_SUPPLY_CHAIN_PHONE='<本地登录手机号>'
export LOCAL_SUPPLY_CHAIN_PASSWORD='<本地登录密码>'
pnpm sandbox:init
```

## 从线上单向刷新数据

请使用只有 `CONNECT`/`SELECT` 权限的 PostgreSQL 账号。该操作会覆盖上一次本地修改，但不会对线上执行 SQL 写入。

```bash
export PRODUCTION_DATABASE_URL='<线上只读 PostgreSQL URL>'
export LOCAL_SUPPLY_CHAIN_PHONE='<本地登录手机号>'
export LOCAL_SUPPLY_CHAIN_PASSWORD='<本地登录密码>'
pnpm sandbox:sync
```

## 本地运行环境

`apps/api/.env` 必须至少包含：

```dotenv
DATABASE_URL=postgresql://<本机用户名>@localhost:5432/dianjie_v4_local
PREVIEW_MODE=true
SANDBOX_MODE=true
PREVIEW_TENANT_SLUG=dianjie
API_PORT=4444
API_HOST=127.0.0.1
MEITUAN_ENABLED=false
CMB_SYNC_ENABLED=false
AUTO_FIX_MODE=off
```

`apps/web/.env.local` 包含：

```dotenv
NEXT_PUBLIC_API_BASE=http://localhost:4444
NEXT_PUBLIC_SANDBOX_MODE=true
```

安全护栏会在 `PREVIEW_MODE`/`SANDBOX_MODE` 下拒绝任何非 localhost 或库名不包含 `dianjie_v4_local` 的数据库连接。
