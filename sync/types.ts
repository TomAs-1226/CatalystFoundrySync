export interface Statement {bind(...values:unknown[]):Statement;first<T=Record<string,unknown>>():Promise<T|null>;all<T=Record<string,unknown>>():Promise<{results:T[]}>;run():Promise<{meta:{changes:number}}>;}
export interface Database {prepare(sql:string):Statement;batch(statements:Statement[]):Promise<unknown[]>;}
export class ApiError extends Error {constructor(public status:number,message:string){super(message);}}
export const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
export async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');}
export function canonical(value:unknown):string {const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,sort(x)])):v;return JSON.stringify(sort(value));}
export interface Member {id:string;login:string;}
