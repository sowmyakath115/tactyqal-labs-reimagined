import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'tactyqal-test-'));let child,base,cookie,postId;
async function boot(){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,NODE_ENV:'test',PORT:'0',DATABASE_PATH:join(dir,'test.sqlite'),ADMIN_PASSWORD:'test-password'}});await new Promise((resolve,reject)=>{let buffer='';const t=setTimeout(()=>reject(new Error('Server startup timeout')),5000);child.stdout.on('data',x=>{buffer+=x;const m=buffer.match(/running on port (\d+)/);if(m){base='http://127.0.0.1:'+m[1];clearTimeout(t);resolve();}});child.once('exit',()=>{clearTimeout(t);reject(new Error('Server exited early'));});});}
async function stop(){if(child&&!child.killed){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}}
async function req(path,method='GET',data,auth=false,extra={}){const r=await fetch(base+path,{method,headers:{...(data?{'content-type':'application/json'}:{}),...(auth?{cookie}:{}),...extra},body:data?JSON.stringify(data):undefined});return {status:r.status,headers:r.headers,data:await r.json()};}
const sample={title:'A test post',slug:'a-test-post',excerpt:'A useful excerpt for the blog.',body:'A body long enough to pass the validation rule.',category:'Product',status:'draft'};
before(boot);after(async()=>{await stop();rmSync(dir,{recursive:true,force:true});});
test('seed posts and public search',async()=>{const r=await req('/api/posts');assert.equal(r.status,200);assert.equal(r.data.total,3);assert.equal((await req('/api/posts?q=prototyping')).data.total,1);assert.equal((await req('/api/posts?limit=1&page=2')).data.posts.length,1);});
test('admin endpoints deny anonymous access',async()=>{assert.equal((await req('/api/admin/posts')).status,401);assert.equal((await req('/api/posts','POST',sample)).status,401);});
test('login sets protected session cookie',async()=>{assert.equal((await req('/api/auth/login','POST',{password:'wrong'})).status,401);const r=await req('/api/auth/login','POST',{password:'test-password'});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);cookie=r.headers.get('set-cookie').split(';')[0];});
test('cross-origin writes are blocked',async()=>{assert.equal((await req('/api/posts','POST',sample,true,{origin:'https://example.com'})).status,403);});
test('validation rejects invalid posts',async()=>{assert.equal((await req('/api/posts','POST',{...sample,slug:'invalid slug'},true)).status,400);});
test('create draft; private content remains hidden',async()=>{const r=await req('/api/posts','POST',sample,true);assert.equal(r.status,201);postId=r.data.id;assert.equal((await req('/api/posts/a-test-post')).status,404);assert.equal((await req('/api/posts')).data.total,3);assert.equal((await req('/api/admin/posts?status=draft','GET',undefined,true)).data.total,1);});
test('duplicate slugs are rejected',async()=>{assert.equal((await req('/api/posts','POST',sample,true)).status,409);});
test('publish, retrieve and update',async()=>{const r=await req('/api/posts/'+postId,'PATCH',{status:'published',title:'Updated title'},true);assert.equal(r.status,200);const p=await req('/api/posts/a-test-post');assert.equal(p.data.title,'Updated title');assert.ok(p.data.published_at);assert.equal((await req('/api/posts')).data.total,4);});
test('database persists after server restart',async()=>{await stop();await boot();assert.equal((await req('/api/posts/a-test-post')).data.title,'Updated title');const r=await req('/api/auth/login','POST',{password:'test-password'});cookie=r.headers.get('set-cookie').split(';')[0];});
test('delete and sign out',async()=>{assert.equal((await req('/api/posts/'+postId,'DELETE',undefined,true)).status,200);assert.equal((await req('/api/posts/a-test-post')).status,404);assert.equal((await req('/api/auth/logout','POST',undefined,true)).status,200);assert.equal((await req('/api/admin/posts','GET',undefined,true)).status,401);});
test('public pages and scripts served with security headers',async()=>{for(const route of ['/','/blog','/blog/guide-to-prototyping','/admin','/styles.css','/app.js','/admin.js']){const r=await fetch(base+route);assert.equal(r.status,200,route);assert.ok(r.headers.get('content-security-policy'));assert.ok((await r.text()).length>100);}assert.equal((await fetch(base+'/not-a-page')).status,404);});
