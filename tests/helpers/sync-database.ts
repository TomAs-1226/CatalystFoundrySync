import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import type {Database,Statement} from '../../sync/types';
export function sqliteDatabase(file=':memory:'){
 const sqlite=new DatabaseSync(file);sqlite.exec('PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;');sqlite.exec(readFileSync(new URL('../../sync/migrations/0001.sql',import.meta.url),'utf8'));
 class Prepared implements Statement{
  constructor(private sql:string,private values:unknown[]=[]){ }
  bind(...values:unknown[]){return new Prepared(this.sql,values);}
  async first<T=Record<string,unknown>>(){return (sqlite.prepare(this.sql).get(...this.values as never[])??null)as T|null;}
  async all<T=Record<string,unknown>>(){return{results:sqlite.prepare(this.sql).all(...this.values as never[])as T[]};}
  runSync(){const result=sqlite.prepare(this.sql).run(...this.values as never[]);return{meta:{changes:Number(result.changes)}};}
  async run(){return this.runSync();}
 }
 const db:Database={prepare:sql=>new Prepared(sql),batch:async statements=>{sqlite.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>(s as Prepared).runSync());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 return{db,sqlite,close:()=>sqlite.close()};
}
