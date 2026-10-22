'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),path=require('node:path');
const load=()=>import('../license-issuer/release-preflight.mjs');
function fixture(){
 const base='https://project-hub-license.kieiyellow.workers.dev';
 return {format:'project-hub-release-readback-v1',mode:'live',provider:'stripe-live',product:'project-hub-4.123',trialDays:30,
 deviceLimits:{mac:2,windows:2},builds:['mac','windows'].map(os=>({id:`project-hub-4.125.2-${os==='mac'?'mac-arm64':'windows-x64'}`,os,scope:{channel:'release',product:'project-hub-4.123',bugfixOf:[]},betaExpiresAt:null,globalEndAt:null})),
 prices:[{kind:'regular',amount:4900,currency:'jpy',current:true},{kind:'intro',amount:1100,currency:'jpy',current:true}],
 endpoints:{buy:base+'/buy',complete:base+'/purchase/complete',webhook:base+'/stripe/webhook'},logging:{workerLogsEnabled:false,observabilityEnabled:false},limiter:{bindingConfigured:true,namespaceConfigured:true},
 verification:Object.fromEntries(['ownerVerified','accountLiveVerified','apiKeyModeLiveVerified','apiKeyPermissionsVerified','checkoutKeyRestrictedVerified','webhookLiveVerified','issuerKeyUnchangedVerified','schemaVerified','paymentLinkLiveVerified'].map(k=>[k,true])),windowsIssuerEnabled:false};
}
test('normalized offline readback: Mac ready; Windows explicitly blocked without enabling it',async()=>{
 const {preflightRelease}=await load(),f=fixture(),before=JSON.stringify(f),r=preflightRelease(f);
 assert.equal(r.status,'READY');assert.equal(r.mac,'ready');assert.equal(r.windows,'blocked');assert.equal(r.windowsReason,'issuer_disabled');assert.equal(JSON.stringify(f),before);
 f.windowsIssuerEnabled=true;assert.equal(preflightRelease(f).windows,'ready');
});
test('each missing or unknown owner verification is NOT_READY',async()=>{
 const {preflightRelease}=await load();
 for(const key of Object.keys(fixture().verification))for(const v of [false,null,'true',undefined]){
 const f=fixture();f.verification[key]=v;assert.equal(preflightRelease(f).status,'NOT_READY',key);
 }
});
test('all production contract boundaries fail closed',async()=>{
 const {preflightRelease}=await load();
 const mutations=[f=>f.mode='test',f=>f.provider='stripe-test',f=>f.product='project-hub-4.125.2',f=>f.trialDays=31,f=>f.deviceLimits.mac=3,f=>f.deviceLimits.windows=1,
 f=>f.builds[0].id='project-hub-4.125.0-mac-arm64',f=>f.builds[1].os='mac',f=>f.builds[0].scope.channel='beta',f=>f.builds[0].scope.product='other',f=>f.builds[0].scope.bugfixOf=['other'],f=>f.builds[0].globalEndAt=1,f=>f.builds[1].betaExpiresAt=1,
 f=>f.prices[0].amount=4901,f=>f.prices[1].amount=1000,f=>f.prices[0].currency='usd',f=>f.prices[1].current=false,f=>f.prices[1].kind='regular',f=>f.prices.push(f.prices[0]),
 f=>f.logging.workerLogsEnabled=true,f=>f.logging.observabilityEnabled=true,f=>f.limiter.namespaceConfigured=false,f=>f.limiter.bindingConfigured=false];
 for(const mutate of mutations){const f=fixture();mutate(f);assert.equal(preflightRelease(f).status,'NOT_READY');}
});
test('reject raw secrets, code, unknown schema and URL queries without reflecting input',async()=>{
 const {preflightRelease}=await load(),sentinel='sk_live_private_sentinel';
 const mutations=[f=>f.STRIPE_API_KEY=sentinel,f=>f.code=sentinel,f=>f.verification.keyBody=sentinel,f=>f.endpoints.buy+='?code='+sentinel,f=>f.endpoints.webhook='https://unapproved.invalid/'+sentinel,f=>f.endpoints.complete='http://project-hub-license.kieiyellow.workers.dev/purchase/complete'];
 for(const mutate of mutations){const f=fixture();mutate(f);const r=preflightRelease(f);assert.equal(r.status,'NOT_READY');assert.ok(!JSON.stringify(r).includes(sentinel));}
 for(const f of [null,[],{},'private'])assert.equal(preflightRelease(f).status,'NOT_READY');
});
test('stdin CLI returns fixed safe JSON, rejects malformed/oversized input, does not use network',()=>{
 const cli=path.resolve(__dirname,'../license-issuer/release-preflight.mjs');
 for(const [input,status] of [[JSON.stringify(fixture()),0],['{"secret":"private-sentinel"',1],['x'.repeat(33000),1]]){
 const r=spawnSync(process.execPath,[cli],{input,encoding:'utf8'});assert.equal(r.status,status);assert.equal(r.stderr,'');assert.ok(!r.stdout.includes('private-sentinel'));assert.equal(JSON.parse(r.stdout).status,status?'NOT_READY':'READY');
 }
});
