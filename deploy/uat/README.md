# 供应链 UAT 环境

该环境用于异地业务角色灰度测试，不连接生产数据库，也不允许执行真实付款、银行同步、自动修复或生产定时任务。

默认拓扑：

- Web：`127.0.0.1:3205`
- API：`127.0.0.1:4005`
- 数据库：`dianjie_v4_uat`
- Redis：DB 5
- 租户：`supply-chain-uat`
- 远端目录：`/app/dianjie-v4-uat`
- PM2：`dianjie-v4-uat-api`、`dianjie-v4-uat-web`

部署必须从 `release/supply-chain-uat-*` 的干净工作树执行：

```bash
./scripts/deploy-uat.sh
```

可通过环境变量覆盖端口、域名、数据库名和租户：

```bash
# 默认：IP + 独立端口 HTTP 模式（阿里云未备案域名在 80/443 会被 ICP 拦截）
UAT_PORT=8085 ./scripts/deploy-uat.sh

# 可选：已有备案域名时启用 HTTPS（certbot 自动签发）
UAT_HTTPS_DOMAIN=uat.example.com \
UAT_DB_NAME=dianjie_v4_uat \
UAT_TENANT_SLUG=supply-chain-uat \
./scripts/deploy-uat.sh
```

注意：端口模式需要先在阿里云安全组放行 `UAT_PORT`（默认 8085）的 TCP 入方向。

首次部署会在服务器生成 `/app/dianjie-v4-uat/.uat-seed-password`，该文件权限为 `600`，不会写入 Git。UAT 账号由 `apps/api/scripts/seed-upstream-uat.ts` 幂等创建。

| 角色 | 手机号 |
| --- | --- |
| 供应链采购 | `13970000001` |
| 第二复核人 | `13970000002` |
| 财务 | `13970000003` |
| 上游供应商负责人 | `13970000004` |
| 隔离验证供应商 | `13970000005` |
| 门店经理 | `13970000006` |
| 厨师长 | `13970000007` |

发布脚本会依次执行测试、构建、独立数据库迁移、种子初始化、PM2 启动、HTTPS 配置和外部健康检查。任何一步失败都不会修改生产数据库或重启生产进程。
