import { prisma } from '@dianjie/db'
import { credentialContext, sealCredential, openCredential } from '../../lib/credential-vault'

export interface ActiveToken {
  appAuthToken: string
  refreshToken?: string
  expiresAt?: Date
}

export class DbTokenStore {
  constructor(private orgId: number) {}

  /** 拿当前有效 token. 首次启动会从 .env 引导值种入 DB. */
  async getActive(): Promise<string> {
    let row = await prisma.meituanAuthToken.findUnique({ where: { orgId: this.orgId } })
    if (!row) {
      const bootstrap = process.env.MEITUAN_BOOTSTRAP_AUTH_TOKEN
      if (!bootstrap) {
        throw new Error(
          `MeituanAuthToken DB 空, 且 MEITUAN_BOOTSTRAP_AUTH_TOKEN env 未设置. ` +
          `凭证未就绪, 无法调真实 API. (mock 模式不应走到这里)`,
        )
      }
      row = await prisma.meituanAuthToken.create({
        data: {
          orgId: this.orgId,
          appAuthToken: sealCredential(bootstrap, credentialContext(this.orgId, 'meituan', 'appAuthToken'))!,
          refreshToken: sealCredential(process.env.MEITUAN_BOOTSTRAP_REFRESH_TOKEN || null, credentialContext(this.orgId, 'meituan', 'refreshToken')),
        },
      })
    }
    return openCredential(row.appAuthToken, credentialContext(this.orgId, 'meituan', 'appAuthToken'))!
  }

  /** refresh 成功后回写新 token (refresh 接口路径等美团回复后再实现, 这里只暴露 setter) */
  async update(newToken: {
    appAuthToken: string
    refreshToken?: string
    expiresAt?: Date
  }): Promise<void> {
    const protectedToken = { ...newToken,
      appAuthToken: sealCredential(newToken.appAuthToken, credentialContext(this.orgId, 'meituan', 'appAuthToken'))!,
      ...(newToken.refreshToken !== undefined ? { refreshToken: sealCredential(newToken.refreshToken, credentialContext(this.orgId, 'meituan', 'refreshToken')) } : {}),
    }
    await prisma.meituanAuthToken.upsert({
      where: { orgId: this.orgId },
      create: {
        orgId: this.orgId,
        ...protectedToken,
      },
      update: {
        ...protectedToken,
        lastRefreshedAt: new Date(),
        refreshAttempts: 0,
      },
    })
  }

  /** refresh 失败时记录 */
  async recordRefreshFailure(): Promise<void> {
    await prisma.meituanAuthToken.update({
      where: { orgId: this.orgId },
      data: { refreshAttempts: { increment: 1 } },
    })
  }
}
