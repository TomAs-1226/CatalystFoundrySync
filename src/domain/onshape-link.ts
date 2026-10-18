export class OnshapeError extends Error {
  constructor(public code:string,message:string){super(message);this.name='OnshapeError';}
}
export interface OnshapeLink {documentId:string;referenceType:'w'|'v'|'m';referenceId:string;elementId:string;configuration:string;immutable:boolean;versionId?:string;}
/** A link supplies identifiers only. It never supplies an upstream host or credential. */
export function parseOnshapeUrl(value:string):OnshapeLink {
  let url:URL;
  try{url=new URL(value.trim());}catch{throw new OnshapeError('INVALID_URL','Paste a complete Onshape document link.');}
  if(url.protocol!=='https:'||url.hostname!=='cad.onshape.com'||url.port||url.username||url.password)throw new OnshapeError('INVALID_HOST','Only HTTPS cad.onshape.com document links are supported.');
  const match=/^\/documents\/([a-f\d]{24})\/([wvm])\/([a-f\d]{24})\/e\/([a-f\d]{24})\/?$/i.exec(url.pathname);
  if(!match)throw new OnshapeError('INVALID_URL','Expected an Onshape document, workspace/version and element link.');
  const referenceType=match[2].toLowerCase() as OnshapeLink['referenceType'];
  return{documentId:match[1].toLowerCase(),referenceType,referenceId:match[3].toLowerCase(),elementId:match[4].toLowerCase(),configuration:url.searchParams.get('configuration')??'default',immutable:referenceType!=='w',...(referenceType==='v'?{versionId:match[3].toLowerCase()}:{})};
}
export function canonicalOnshapeUrl(value:string){const link=parseOnshapeUrl(value);if(!link.configuration||link.configuration.length>1500||/[\r\n\0]/.test(link.configuration))throw new Error('The Onshape configuration is invalid.');return`https://cad.onshape.com/documents/${link.documentId}/${link.referenceType}/${link.referenceId}/e/${link.elementId}?${new URLSearchParams({configuration:link.configuration})}`;}
/** Discovery accepts a document link too; manufacturing still requires a selected version and element. */
export function parseRobotInput(value:string):{documentId:string;versionId?:string;elementId?:string;configuration:string}{
 let url:URL;try{url=new URL(value.trim());}catch{throw new OnshapeError('INVALID_URL','Paste the robot’s complete Onshape link.');}
 if(url.protocol!=='https:'||url.hostname!=='cad.onshape.com'||url.port||url.username||url.password)throw new OnshapeError('INVALID_HOST','Use an HTTPS cad.onshape.com robot link.');
 const match=/^\/documents\/([a-f\d]{24})(?:\/([wv])\/([a-f\d]{24})(?:\/e\/([a-f\d]{24}))?)?\/?$/i.exec(url.pathname);
 if(!match)throw new OnshapeError('INVALID_URL','Use an Onshape document, saved-version or workspace link.');
 const configuration=url.searchParams.get('configuration')??'default';if(!configuration||configuration.length>1500||/[\r\n\0]/.test(configuration))throw new OnshapeError('INVALID_CONFIGURATION','The Onshape configuration is invalid.');
 return{documentId:match[1].toLowerCase(),configuration,...(match[2]?.toLowerCase()==='v'?{versionId:match[3].toLowerCase()}:{}),...(match[4]?{elementId:match[4].toLowerCase()}:{})};
}
