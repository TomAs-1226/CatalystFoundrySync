import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import SyncWorkspace,{type SyncClient} from '../src/components/SyncWorkspace';
import type {SyncStatus} from '../src/adapters/sync';
import '../src/catalyst-identity.css';
import '../src/components/sync-workspace.css';
import './styles.css';
let api='',token='';
const config=await fetch('./config.json',{cache:'no-store'}).then(r=>r.json()).catch(()=>({apiUrl:''}));
if(config.apiUrl){const url=new URL(config.apiUrl);if(url.protocol==='https:'&&url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash)api=url.origin;}
async function request<T>(path:string,method='GET',body?:unknown,anonymous=false):Promise<T>{if(!api)throw new Error('The administrator has not configured the private sync backend.');const route=path.replace(/^\/records/,'/reservations');const response=await fetch(api+'/v1'+route,{method,headers:{...(token&&!anonymous?{Authorization:`Bearer ${token}`}:{ }),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error'});const result=await response.json();if(!response.ok)throw new Error(result.error??'The team service is unavailable.');return result as T;}
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const client:SyncClient={request,
 async status(){if(!api)return{configured:false,signedIn:false,url:'',reason:'The team service has not been configured.'};if(!token)return{configured:true,signedIn:false,url:api,reason:'Sign in to open the shared workspace. Your Onshape connection stays private to your account.'};try{return{configured:true,signedIn:true,url:api,...await request<{user:{id:string;login:string};onshapeConnected:boolean;team:string}>('/session'),reason:'Shared records fetched from your private team service.'} as SyncStatus;}catch(e){return{configured:true,signedIn:false,url:api,reason:(e as Error).message};}},
 async connect(kind,signal){const popup=window.open('about:blank','_blank');if(!popup)throw new Error('Allow this sign-in popup, then retry.');try{const verifier=hex(crypto.getRandomValues(new Uint8Array(32))),challenge=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));const flow=await request<{id:string;url:string}>(kind==='github'?'/login/start':'/onshape/start','POST',{challenge},kind==='github');const url=new URL(flow.url);if(url.origin!==api||url.pathname!=='/auth/launch')throw new Error('Unexpected authorization URL.');popup.location.href=url.href;const until=Date.now()+600000;while(Date.now()<until&&!signal.aborted){const result=await request<{pending?:boolean;token?:string}>(kind==='github'?'/login/finish':'/onshape/finish','POST',{id:flow.id,verifier},kind==='github');if(!result.pending){if(result.token)token=result.token;return client.status();}await new Promise(r=>setTimeout(r,1500));}throw new Error('Sign-in timed out or was cancelled. Retry when ready.');}catch(e){popup.close();throw e;}},
 async logout(){try{if(token)await request('/logout','POST',{});}finally{token='';}return client.status();}
};
function Website(){const[workOrder,setWorkOrder]=useState(sessionStorage.getItem('foundry-work-order')??'');return <><header className="site-header"><a href="./">Catalyst <strong>Foundry</strong></a><span>Team workspace</span></header><main><SyncWorkspace client={client} workOrder={workOrder} onWorkOrder={value=>{setWorkOrder(value);sessionStorage.setItem('foundry-work-order',value);}}/></main><footer className="site-footer">Shared workspace · Sign-in required · Operator-owned manufacturing records</footer></>;}
createRoot(document.getElementById('root')!).render(<Website/>);
