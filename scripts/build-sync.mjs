import {build} from 'vite';
import {build as bundle} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
await build({configFile:false,root:resolve('web'),base:'./',build:{outDir:resolve('web-dist'),emptyOutDir:true,target:'es2022'}});
const apiUrl=process.env.FOUNDRY_SYNC_URL??JSON.parse((await readFile('web/config.json','utf8')).replace(/^\uFEFF/,'')).apiUrl;
if(apiUrl){const url=new URL(apiUrl);if(url.protocol!=='https:'||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw new Error('FOUNDRY_SYNC_URL must be the public HTTPS API origin.');}
await writeFile('web-dist/config.json',JSON.stringify({apiUrl}));
await writeFile('web-dist/.nojekyll','');
await mkdir('sync-dist',{recursive:true});
await bundle({entryPoints:['sync/worker.ts'],outfile:'sync-dist/worker.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:false});
await copyFile('sync/migrations/0001.sql','sync-dist/0001.sql');
for(const name of ['0002_team_sources.sql','0003_onshape_budget.sql','0004_shared_cad.sql'])await copyFile('sync/migrations/'+name,'sync-dist/'+name);
console.log('Static website and private Worker bundle built. No deployment or account connection was performed.');
