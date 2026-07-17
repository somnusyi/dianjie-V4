import { isSafeTestDatabaseUrl } from '../helpers/testDatabase'

if (!isSafeTestDatabaseUrl(process.env.DATABASE_URL)) {
  throw new Error(
    '拒绝运行数据库集成测试：DATABASE_URL 的数据库名必须以 _test 或 _ci 结尾',
  )
}
