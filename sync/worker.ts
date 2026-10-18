import {fetchOnshapeRead} from './onshape-download';
import {chargeOnshapeAttempt,onshapeBudget} from './onshape-budget';
import {z} from 'zod';
import {authenticate,callback,finishFlow,launch,onshapeAccess,revokeSession,startFlow,type Env} from './auth';
import {ApiError,digest} from './types';
import {Ledger} from './ledger';
import {listTeamSources,saveTeamSource} from './sources';
import {listSharedCad,publishSharedCad,readSharedCad,removeSharedCad} from './shared-cad';
const headers=(env:Env,origin:string|null)=>({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...(origin===env.SITE_ORIGIN?{'Access-Control-Allow-Origin':origin,Vary:'Origin','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS'}:{})});
async function json(request:Request,maxBytes=1024*1024){if(!request.headers.get('content-type')?.startsWith('application/json'))throw new ApiError(415,'Send JSON to this endpoint.');const reader=request.body?.getReader();if(!reader)throw new ApiError(400,'Send a JSON body.');let size=0;const chunks:Uint8Array[]=[];for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maxBytes){await reader.cancel();throw new ApiError(413,maxBytes>1024*1024?'Shared CAD upload exceeds 10 MiB. Share a smaller subsystem.':'Sync accepts metadata up to 1 MiB on this endpoint.');}chunks.push(next.value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new ApiError(400,'Invalid JSON.');}}
async function loginLimit(request:Request,env:Env){const now=Date.now(),key=await digest(`login:${request.headers.get('CF-Connecting-IP')??'local'}:${env.GITHUB_CLIENT_ID}`);const row=await env.DB.prepare('INSERT INTO rate_limits(key,hits,resets) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN resets<? THEN 1 ELSE hits+1 END,resets=CASE WHEN resets<? THEN excluded.resets ELSE resets END RETURNING hits').bind(key,now+300000,now,now).first<{hits:number}>();if(!row||row.hits>10)throw new ApiError(429,'Too many sign-in attempts. Wait five minutes before retrying.');}
async function proxyOnshape(request:Request,env:Env,fetcher:typeof fetch){const member=await authenticate(request,env),body=z.object({method:z.literal('GET'),path:z.string().min(1).max(8000),binary:z.boolean().optional()}).strict().parse(await json(request));
 if(!body.path.startsWith('/api/v17/')||/[\\\r\n]/.test(body.path))throw new ApiError(400,'Only supported immutable Onshape read/export endpoints are accepted.');
 const url=new URL(body.path,'https://cad.onshape.com'),pathname=decodeURIComponent(url.pathname);
 const id='[a-fA-F0-9]{24}',ref=`d/${id}/v/${id}/e/${id}`;
 const allowed=[/^\/api\/v17\/documents$/,new RegExp(`^/api/v17/documents/d/${id}/versions$`),new RegExp(`^/api/v17/documents/d/${id}/v/${id}/elements$`),new RegExp(`^/api/v17/elements/${ref}/configuration$`),new RegExp(`^/api/v17/assemblies/${ref}$`),new RegExp(`^/api/v17/parts/${ref}$`),new RegExp(`^/api/v17/parts/${ref}/partid/[^/]+/(boundingboxes|stl)$`)];
 if(url.origin!=='https://cad.onshape.com'||!allowed.some(pattern=>pattern.test(pathname))||pathname.includes('..'))throw new ApiError(400,'This Onshape API operation is not available through the read-only connection.');
 const token=await onshapeAccess(env,member,fetcher);
 const response=await fetchOnshapeRead(url,token,body.binary===true,fetcher,env.ONSHAPE_REGIONAL_STL_AUTH==='enabled',()=>chargeOnshapeAttempt(env.DB));
 return new Response(response.body,{headers:{'Content-Type':body.binary?'application/octet-stream':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
export function createWorker(fetcher:typeof fetch=(input,init)=>globalThis.fetch(input,init)){return{
 async fetch(request:Request,env:Env):Promise<Response>{const url=new URL(request.url),origin=request.headers.get('Origin');const baseHeaders=headers(env,origin);
  try{
   if(origin&&origin!==env.SITE_ORIGIN)throw new ApiError(403,'This sync service accepts its configured website only.');
   if(request.method==='OPTIONS')return new Response(null,{status:204,headers:baseHeaders});
   if(request.method==='GET'&&url.pathname==='/health')return Response.json({service:'Catalyst Foundry Sync',version:1,configured:!!env.GITHUB_CLIENT_ID&&!!env.GITHUB_CLIENT_SECRET&&!!env.TOKEN_ENCRYPTION_KEY,team:env.TEAM_ID},{headers:baseHeaders});
   if(!env.PUBLIC_ORIGIN||new URL(env.PUBLIC_ORIGIN).protocol!=='https:'||url.origin!==env.PUBLIC_ORIGIN)throw new ApiError(503,'The public HTTPS service origin is not configured.');
   if(request.method==='GET'&&url.pathname==='/auth/launch')return await launch(request,env);
   if(request.method==='GET'&&url.pathname.startsWith('/auth/callback/'))return await callback(request,env,fetcher);
   if(request.method==='POST'&&url.pathname==='/v1/login/start'){await loginLimit(request,env);const body=z.object({challenge:z.string()}).strict().parse(await json(request));return Response.json(await startFlow(env,'github',body.challenge),{headers:baseHeaders});}
   if(request.method==='POST'&&url.pathname==='/v1/login/finish')return Response.json(await finishFlow(env,await json(request)),{headers:baseHeaders});
   const member=await authenticate(request,env),ledger=new Ledger(env.DB,env.TEAM_ID);
   let data:unknown;
   if(request.method==='GET'&&url.pathname==='/v1/session'){const onshape=await env.DB.prepare('SELECT user_id FROM onshape_tokens WHERE user_id=?').bind(member.id).first();data={user:member,onshapeConnected:!!onshape,team:env.TEAM_ID,membershipPolicy:env.ALLOWED_GITHUB_IDS.trim()==='*'?'open':'restricted'};}
   else if(request.method==='POST'&&url.pathname==='/v1/logout')data=await revokeSession(request,env);
   else if(request.method==='GET'&&url.pathname==='/v1/preferences')data=await ledger.preferences(member);
   else if(request.method==='PUT'&&url.pathname==='/v1/preferences')data=await ledger.savePreferences(member,await json(request));
   else if(request.method==='GET'&&url.pathname==='/v1/reservations')data={records:await ledger.list()};
   else if(request.method==='GET'&&url.pathname==='/v1/cad/snapshots')data={snapshots:await listSharedCad(env.DB,env.TEAM_ID)};
   else if(request.method==='POST'&&url.pathname==='/v1/cad/snapshots')data=await publishSharedCad(env.DB,env.TEAM_ID,member,await json(request,10*1024*1024));
   else if(request.method==='GET'&&/^\/v1\/cad\/snapshots\/[a-f0-9]{64}$/.test(url.pathname))data=await readSharedCad(env.DB,env.TEAM_ID,url.pathname.split('/').at(-1)!);
   else if(request.method==='DELETE'&&/^\/v1\/cad\/snapshots\/[a-f0-9]{64}$/.test(url.pathname))data=await removeSharedCad(env.DB,env.TEAM_ID,member,url.pathname.split('/').at(-1)!);
   else if(request.method==='GET'&&url.pathname==='/v1/sources')data={sources:await listTeamSources(env.DB,env.TEAM_ID)};
   else if(request.method==='POST'&&url.pathname==='/v1/sources')data=await saveTeamSource(env.DB,env.TEAM_ID,member,await json(request));
   else if(request.method==='POST'&&url.pathname==='/v1/reservations')data=await ledger.reserve(member,await json(request));
   else if(request.method==='GET'&&/^\/v1\/reservations\/[a-f0-9]{64}$/.test(url.pathname))data=await ledger.get(url.pathname.split('/').at(-1)!);
   else if(request.method==='POST'&&/^\/v1\/reservations\/[a-f0-9]{64}\/events$/.test(url.pathname))data=await ledger.transition(member,url.pathname.split('/').at(-2)!,await json(request));
   else if(request.method==='GET'&&url.pathname==='/v1/onshape/budget')data=await onshapeBudget(env.DB);
   else if(request.method==='POST'&&url.pathname==='/v1/onshape/start'){const body=z.object({challenge:z.string()}).strict().parse(await json(request));data=await startFlow(env,'onshape',body.challenge,member);}
   else if(request.method==='POST'&&url.pathname==='/v1/onshape/finish')data=await finishFlow(env,await json(request),member);
   else if(request.method==='DELETE'&&url.pathname==='/v1/onshape'){await env.DB.prepare('DELETE FROM onshape_tokens WHERE user_id=?').bind(member.id).run();data={disconnected:true};}
   else if(request.method==='POST'&&url.pathname==='/v1/onshape/request'){const response=await proxyOnshape(request,env,fetcher);for(const [key,value]of Object.entries(baseHeaders))if(key!=='Content-Type')response.headers.set(key,value);return response;}
   else throw new ApiError(404,'Sync endpoint not found.');
   return Response.json(data,{headers:baseHeaders});
  }catch(error){const status=error instanceof ApiError?error.status:error instanceof z.ZodError?400:503;return Response.json({error:error instanceof ApiError?error.message:error instanceof z.ZodError?'The request did not match the sync contract.':'The sync service is unavailable. No manufacturing action was confirmed.'},{status,headers:baseHeaders});}
 },
 async scheduled(_controller:unknown,env:Env){const now=Date.now();await env.DB.batch([env.DB.prepare('DELETE FROM oauth_flows WHERE expires<?').bind(now),env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(now),env.DB.prepare('DELETE FROM rate_limits WHERE resets<?').bind(now)]);}
};}
export default createWorker();
