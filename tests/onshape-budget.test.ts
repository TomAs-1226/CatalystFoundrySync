import {afterEach,expect,it,vi} from 'vitest';
import {sqliteDatabase} from './helpers/sync-database';
import {chargeOnshapeAttempt,onshapeBudget,ONSHAPE_REQUEST_CAP} from '../sync/onshape-budget';
import {fetchOnshapeRead} from '../sync/onshape-download';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).forEach(fn=>fn()));
it('shares one persistent cap across users and concurrent requests, with no automatic reset',async()=>{
 const db=sqliteDatabase();clean.push(db.close);
 for(let i=0;i<ONSHAPE_REQUEST_CAP-1;i++)await chargeOnshapeAttempt(db.db);
 const results=await Promise.allSettled(Array.from({length:8},()=>chargeOnshapeAttempt(db.db)));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(await onshapeBudget(db.db)).toMatchObject({attempts:1000,remaining:0,authoritative:false,automaticReset:false});
 await expect(chargeOnshapeAttempt(db.db)).rejects.toThrow(/Saved projects still slice offline/);
});
it('charges each allowed redirect hop and stops before an upstream fetch when exhausted',async()=>{
 const db=sqliteDatabase();clean.push(db.close);
 const fetcher=vi.fn(async()=>new Response(null,{status:307,headers:{Location:'https://cad-usw2.onshape.com/download/test'}}));
 const url=new URL('https://cad.onshape.com/api/v17/parts/d/'+'a'.repeat(24)+'/v/'+'b'.repeat(24)+'/e/'+'c'.repeat(24)+'/partid/P/stl');
 await expect(fetchOnshapeRead(url,'synthetic',true,fetcher,true,()=>chargeOnshapeAttempt(db.db))).rejects.toThrow(/too many/);
 expect((await onshapeBudget(db.db)).attempts).toBe(4);
 for(let i=4;i<ONSHAPE_REQUEST_CAP;i++)await chargeOnshapeAttempt(db.db);
 fetcher.mockClear();
 await expect(fetchOnshapeRead(url,'synthetic',true,fetcher,true,()=>chargeOnshapeAttempt(db.db))).rejects.toThrow(/reserve/);
 expect(fetcher).not.toHaveBeenCalled();
});
