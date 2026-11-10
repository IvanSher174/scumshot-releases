'use strict';
// Runs on GitHub, never in the distributed launcher. Only an allowlisted summary
// is published. No API responses, player lists, tokens or private keys are logged.
const crypto=require('node:crypto');
async function limitedJSON(response,limit=1024*1024){
 if(!response.ok||!response.body)throw Error('Remote service rejected the request.');
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('Remote response exceeds the size limit.');chunks.push(chunk);}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function collect({token,key,server,request=fetch,now=Date.now}){
 if(typeof token!=='string'||!/^wc_live_[\w-]{8,}$/.test(token))throw Error('WardenCore credential is not configured.');
 if(crypto.createHash('sha256').update(token).digest('hex')==='3209724323d7fde123e9ba60d562cfa005fce9e637492f67995d53a4d6b56156')throw Error('The exposed WardenCore key must be replaced before deployment.');
 const get=async route=>limitedJSON(await request('https://api.wardencore.ru/v1'+route,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)}));
 const status=await get('/server');
 if(typeof status.online!=='boolean')throw Error('Invalid WardenCore server response.');
 let players=status.player_count;
 if(players===null||players===undefined){
  try{players=(await get('/players/online')).online;}catch{players=null;}
 }
 if(!(players===null||Number.isSafeInteger(players)&&players>=0&&players<=10000))throw Error('Invalid WardenCore player count.');
 const payload=Buffer.from(JSON.stringify({kind:'scumshot-public-status',version:1,server,online:status.online||(players!==null&&players>0),players,checkedAt:now()}));
 return {payload:payload.toString('base64'),signature:crypto.sign(null,payload,key).toString('base64')};
}
async function publish(envelope,{repo,token,request=fetch}){
 if(!/^[\w-]+\/[\w.-]+$/.test(repo))throw Error('Invalid repository.');
 async function api(route,method='GET',body,allow404=false){
  const response=await request('https://api.github.com/repos/'+repo+route,{method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000),redirect:'error'});
  if(allow404&&response.status===404)return null;
  return limitedJSON(response);
 }
 let ref=await api('/git/ref/heads/status','GET',undefined,true);
 if(!ref){
  const repository=await api('');
  const base=await api('/git/ref/heads/'+encodeURIComponent(repository.default_branch));
  ref=await api('/git/refs','POST',{ref:'refs/heads/status',sha:base.object.sha});
 }
 const prior=await api('/contents/server-status.json?ref=status','GET',undefined,true);
 await api('/contents/server-status.json','PUT',{message:'Refresh public server status',branch:'status',content:Buffer.from(JSON.stringify(envelope)+'\n').toString('base64'),...(prior?{sha:prior.sha}:{})});
}
module.exports={collect,publish};
if(require.main===module){
 (async()=>{
  const envelope=await collect({token:process.env.WARDEN_API_KEY,key:process.env.STATUS_SIGNING_KEY,server:process.env.STATUS_SERVER});
  await publish(envelope,{repo:process.env.GITHUB_REPOSITORY,token:process.env.GH_TOKEN});
  console.log('Published a signed server status summary. No credentials or player records were published.');
 })().catch(()=>{console.error('Server status publication failed. Check credentials, read permissions and service availability.');process.exitCode=1;});
}
