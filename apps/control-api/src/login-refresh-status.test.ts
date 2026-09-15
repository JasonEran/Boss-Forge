import { describe, expect, it } from 'vitest';
import { loginRefreshPending } from './login-refresh-status.js';
const now=Date.UTC(2026,8,11,7);const request={requestId:'d9ab241b-d180-4abd-a3e1-c724d78a9de6',requestedAt:new Date(now-500).toISOString()};
describe('QR error recovery status',()=>{
 it('keeps a just-accepted refresh pending until the relay consumes it',()=>expect(loginRefreshPending('error',new Date(now-5000).toISOString(),request,now)).toBe(true));
 it('never hides a verification, offline or authenticated state',()=>{for(const state of ['risk_controlled','offline','authenticated'])expect(loginRefreshPending(state,new Date(now).toISOString(),request,now)).toBe(false);});
 it('does not leave dead workers or stale/invalid requests refreshing forever',()=>{
  expect(loginRefreshPending('error',new Date(now-21000).toISOString(),request,now)).toBe(false);
  for(const r of [null,{}, {...request,requestedAt:new Date(now-31000).toISOString()},{...request,requestedAt:new Date(now+1000).toISOString()},{...request,requestedAt:'invalid'}])expect(loginRefreshPending('error',new Date(now).toISOString(),r,now)).toBe(false);
 });
});
