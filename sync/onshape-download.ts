import {ApiError} from './types';
const CAD_ORIGIN='https://cad.onshape.com';
// Observed in a live redirect from the authenticated documented STL endpoint.
// This is an exact Onshape-owned origin, not an arbitrary subdomain or client URL.
const DOWNLOAD_ORIGINS=new Set(['https://cad-usw2.onshape.com']);
const id='[a-fA-F0-9]{24}';
const stlPath=new RegExp('^/api/v17/parts/d/'+id+'/v/'+id+'/e/'+id+'/partid/[^/]+/stl$');
export async function fetchOnshapeRead(url:URL,token:string,binary:boolean,fetcher:typeof fetch,regionalAuthorization=false,beforeRequest?:()=>Promise<void>){
 const exportDownload=binary&&stlPath.test(decodeURIComponent(url.pathname));
 const signal=AbortSignal.timeout(45000);
 let target=url;
 for(let hop=0;hop<4;hop++){
  const onshapeApi=target.origin===CAD_ORIGIN;
  if(target.protocol!=='https:'||target.username||target.password||target.port||!onshapeApi&&(!exportDownload||!DOWNLOAD_ORIGINS.has(target.origin)))throw new ApiError(502,'Export download host '+target.hostname+' requires review. No token was forwarded.');
  if(!onshapeApi&&!regionalAuthorization)throw new ApiError(502,'Onshape regional STL downloads need administrator authorization. No token was forwarded.');
  // Onshape routes the export to a protected regional download handler whose
  // path can differ from the API endpoint. Only the exact reviewed Onshape
  // origin receives its bearer; all other hosts were rejected above.
  const authenticate=onshapeApi||exportDownload&&DOWNLOAD_ORIGINS.has(target.origin);
  await beforeRequest?.();
  const response=await fetcher(target,{method:'GET',headers:{...(authenticate?{Authorization:'Bearer '+token}:{}),Accept:binary?'application/octet-stream':'application/json'},redirect:'manual',signal});
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('Location');await response.body?.cancel();
   if(!location)throw new ApiError(502,'Onshape returned an incomplete export redirect.');
   try{target=new URL(location,target);}catch{throw new ApiError(502,'Onshape returned an invalid export redirect.');}
   continue;
  }
  if(!response.ok){await response.body?.cancel();throw new ApiError(response.status===401?401:response.status===402?402:response.status===403?403:response.status===429?429:502,response.status===402?'Onshape reports its API allocation is exhausted. Saved Foundry projects still slice offline.':response.status===401?'Onshape access was revoked. Reconnect Onshape.':response.status===403?'Onshape denied document/export access. Check sharing and permissions.':'Onshape could not complete this read/export request. Retry later.');}
  return response;
 }
 throw new ApiError(502,'Onshape returned too many export redirects. No geometry was accepted.');
}
