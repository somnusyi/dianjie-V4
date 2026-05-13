# 滇界云管 · 连锁餐饮数字化管理平台

## 本地启动步骤

### 1. 复制环境变量
```bash
cp .env.example .env
```

### 2. 启动数据库
```bash
docker-compose up -d
```

### 3. 安装依赖
```bash
pnpm install
```

### 4. 初始化数据库
```bash
pnpm db:push
pnpm db:seed
```

### 5. 启动服务
```bash
pnpm dev
```

- 前端：http://localhost:3000
- API：http://localhost:4000
- 数据库管理：`pnpm db:studio`

## 登录账号

| 角色 | 邮箱 | 密码 |
|------|------|------|
| 管理员 | admin@dianjie.com | admin123 |
| 财务 | finance@dianjie.com | fin123 |
| 店长 | manager1@dianjie.com | mgr123 |

## 技术栈

- 后端：Node.js + Fastify + TypeScript
- 前端：Next.js 14 + Tailwind CSS
- 数据库：PostgreSQL + Prisma ORM
- 缓存/队列：Redis + BullMQ（账期引擎）
- 部署：Docker + 阿里云 ECS
