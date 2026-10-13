import {afterEach,it,expect,vi} from 'vitest'
import {loginTenant,dedicatedTestLogin} from './login-environment'
afterEach(()=>{vi.unstubAllEnvs()})
it('测试版固定租户，查询和短账号都不能切到正式或test库',()=>{for(const request of ['','dianjie','test','other'])for(const account of ['','fin','13970000001'])expect(loginTenant(request,account,'supply-chain-uat')).toBe('supply-chain-uat')})
it('正式版测试账号去独立测试入口，测试版不回正式',()=>{vi.stubEnv('NEXT_PUBLIC_PREVIEW_TENANT_SLUG','');vi.stubEnv('NEXT_PUBLIC_TEST_LOGIN_URL','http://116.62.32.162:8085/v2/login');expect(dedicatedTestLogin('dianjie','fin')).toContain(':8085');expect(dedicatedTestLogin('test')).toContain(':8085');expect(dedicatedTestLogin('dianjie','staff')).toBeNull();vi.stubEnv('NEXT_PUBLIC_PREVIEW_TENANT_SLUG','supply-chain-uat');expect(dedicatedTestLogin('test','fin')).toBeNull()})
it('未配置独立入口时保留历史租户行为，正式默认dianjie',()=>{expect(loginTenant('','staff','')).toBe('dianjie');expect(loginTenant('','fin','')).toBe('test')})
