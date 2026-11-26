import{beforeEach,afterEach,expect,it,vi}from'vitest'
import{sealCredential,credentialContext}from'../../src/lib/credential-vault'
import{getAccessToken,sendAppMsg,sendCardMsg,exchangeOAuthCode}from'../../src/services/wecom'
const{db}=vi.hoisted(()=>({db:{weComConfig:{findUnique:vi.fn(),update:vi.fn()},weComSyncLog:{create:vi.fn()}}}))
vi.mock('@dianjie/db',()=>({prisma:db}))
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS',JSON.stringify({current:'t',keys:{t:'aa'.repeat(32)}}));db.weComConfig.findUnique.mockImplementation(async()=>({enabled:true,agentId:'1',corpId:'c',appSecret:sealCredential('synthetic-config-secret',credentialContext('tenant','wecom','appSecret')),accessToken:sealCredential('synthetic-cached-token',credentialContext('tenant','wecom','accessToken')),accessTokenExp:new Date(Date.now()+3600000)}));db.weComSyncLog.create.mockResolvedValue({});vi.stubGlobal('fetch',vi.fn().mockResolvedValue({json:async()=>({errcode:400,errmsg:'synthetic-config-secret',access_token:'synthetic-config-secret',data:{secret:'synthetic-config-secret'}})}))})
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()})
it('does not forward provider error text into OAuth 401',async()=>{await expect(exchangeOAuthCode('tenant','synthetic-code')).rejects.toMatchObject({message:'企微授权失败，请重新登录',statusCode:401})})
it('message logs/errors contain neither message contents nor raw provider payload',async()=>{
 await expect(sendAppMsg('tenant','employee','synthetic-config-secret')).rejects.toMatchObject({message:'企微消息发送失败'})
 await expect(sendCardMsg('tenant','employee',{title:'synthetic-config-secret',description:'content',url:'/v2/me'})).rejects.toMatchObject({message:'企微卡片消息发送失败'})
 expect(JSON.stringify(db.weComSyncLog.create.mock.calls)).not.toContain('synthetic-config-secret')
})
it('returns stable provider status on success without echoing response fields',async()=>{
 vi.mocked(fetch).mockResolvedValue({json:async()=>({errcode:0,errmsg:'synthetic-config-secret',token:'synthetic-config-secret'})}as any)
 expect(await sendAppMsg('tenant','employee','hello')).toEqual({errcode:0});expect(JSON.stringify(db.weComSyncLog.create.mock.calls)).not.toContain('synthetic-config-secret')
})
it('network exceptions containing credential URLs are replaced before callers can persist them',async()=>{
 vi.mocked(fetch).mockRejectedValue(new Error('failed https://host?token=synthetic-config-secret'))
 await expect(sendAppMsg('tenant','employee','hello')).rejects.toMatchObject({statusCode:502,message:'企微服务暂时不可用，请稍后重试'})
})
