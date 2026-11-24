import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
const root = dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === 'production';
if (production && !process.env.ADMIN_PASSWORD) throw new Error('Set ADMIN_PASSWORD in production');
const password = process.env.ADMIN_PASSWORD || 'tactyqal-local-demo';
const port = Number(process.env.PORT || 3000);
const dbPath = process.env.DATABASE_PATH || resolve(root, 'data/blog.sqlite');
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), {recursive:true});
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS posts (
 id INTEGER PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, excerpt TEXT NOT NULL,
 body TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','published')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 published_at TEXT
); CREATE INDEX IF NOT EXISTS posts_status_date ON posts(status,published_at DESC); 
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY);`);
const seeds = [
 ['From a small idea to a meaningful product','from-idea-to-product','Start with a real problem, then test the smallest solution that could help.','Start by talking to the people who experience a problem. Ask them what they currently do and what makes that difficult.\n\nWrite down the problem in one sentence. Sketch the smallest product that could help and show it to a few potential users.\n\nBuild only what you need to learn from the next experiment. Measure the result, listen to feedback, and repeat.','Ideation'],
 ['A young builder’s guide to prototyping','guide-to-prototyping','Turn your first sketch into something people can try and give feedback on.','A prototype is a way to test an idea without building every feature. Start with a paper sketch or simple digital mockup.\n\nAsk someone to complete a specific task without your help. Observe where they hesitate, and ask why.\n\nImprove the flow before adding features. A clear experience matters more than a long list of functionality.','Product'],
 ['What makes a strong startup pitch?','strong-startup-pitch','Explain the problem, the audience, and why your solution is worth trying.','A good pitch starts with a specific user and a problem that matters to them. Explain how your product changes their experience.\n\nShow evidence from research or an early prototype. Avoid promises you cannot support.\n\nFinish with a clear next step, such as trying the product, giving feedback, or joining a pilot.','Launch']
];
if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get('seeded')) { db.exec('BEGIN'); try {const insert=db.prepare("INSERT INTO posts(title,slug,excerpt,body,category,status,published_at) VALUES(?,?,?,?,?,'published',CURRENT_TIMESTAMP)"); for (const s of seeds) insert.run(...s); db.prepare('INSERT INTO settings VALUES(?)').run('seeded'); db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;} }
const sessions = new Map(); const attempts = new Map(); const categories = ['Ideation','Product','Launch','Technology'];
const json=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
const bad=(message,status=400)=>{throw new HttpError(status,message);};
function session(req){const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('tactyqal_session='))?.split('=')[1];const expires=sessions.get(token);if(expires && expires>Date.now())return token;if(token)sessions.delete(token);return null;}
function auth(req){if(!session(req))bad('Sign in to manage posts.',401);}
function sameOrigin(req){const origin=req.headers.origin;if(origin){let host;try{host=new URL(origin).host;}catch{bad('Invalid origin',403);}if(host!==req.headers.host)bad('Cross-origin write rejected.',403);}}
async function readJson(req){if(!req.headers['content-type']?.startsWith('application/json'))bad('Expected application/json',415);let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>150000)bad('Request too large',413);chunks.push(chunk);}try{const data=JSON.parse(Buffer.concat(chunks).toString());if(!data||typeof data!=='object'||Array.isArray(data))bad('Expected object');return data;}catch(e){if(e instanceof HttpError)throw e;bad('Invalid JSON');}}
function validate(input){const v={};for(const [key,min,max] of [['title',3,140],['slug',3,120],['excerpt',10,300],['body',20,50000]]){if(typeof input[key]!=='string')bad(`${key} is required`);v[key]=input[key].trim();if(v[key].length<min||v[key].length>max)bad(`${key} must be ${min}–${max} characters`);}if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug))bad('Slug must use lowercase letters, numbers and hyphens');if(!categories.includes(input.category))bad('Invalid category');if(!['draft','published'].includes(input.status))bad('Invalid status');return {...v,category:input.category,status:input.status};}
const postById=id=>db.prepare('SELECT * FROM posts WHERE id=?').get(id);
function listPosts(url,admin=false){const q=(url.searchParams.get('q')||'').trim().slice(0,100);const cat=url.searchParams.get('category');const params=[];const filters=admin?['1=1']:["status='published'"];if(q){filters.push('(instr(lower(title),lower(?))>0 OR instr(lower(excerpt),lower(?))>0)');params.push(q,q);}if(cat&&categories.includes(cat)){filters.push('category=?');params.push(cat);}const requestedStatus=url.searchParams.get('status');if(admin&&['draft','published'].includes(requestedStatus)){filters.push('status=?');params.push(requestedStatus);}const limit=Math.max(1,Math.min(100,Number.parseInt(url.searchParams.get('limit'))||100));const page=Math.max(1,Math.min(100000,Number.parseInt(url.searchParams.get('page'))||1));const where=filters.join(' AND ');const total=db.prepare(`SELECT COUNT(*) AS count FROM posts WHERE ${where}`).get(...params).count;const order=admin?'updated_at DESC,id DESC':'published_at DESC,id DESC';const rows=db.prepare(`SELECT id,title,slug,excerpt,category,status,created_at,updated_at,published_at FROM posts WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params,limit,(page-1)*limit);return {posts:rows,total,page,limit};}
function secureCompare(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
const cookie=(token,maxAge)=>`tactyqal_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${production?'; Secure':''}`;
const files={'/':'index.html','/blog':'blog.html','/admin':'admin.html','/styles.css':'styles.css','/app.js':'app.js','/admin.js':'admin.js'};
const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8'};
const server=http.createServer(async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");try{
 const url=new URL(req.url,'http://localhost');const p=url.pathname.replace(/\/$/,'')||'/';const method=req.method;
 if(!['GET','HEAD','OPTIONS'].includes(method))sameOrigin(req);
 if(p==='/api/health'&&method==='GET')return json(res,200,{status:'ok'});
 if(p==='/api/categories'&&method==='GET')return json(res,200,{categories});
 if(p==='/api/auth/login'&&method==='POST'){const ip=req.socket.remoteAddress||'unknown';const now=Date.now();let a=attempts.get(ip);if(!a||a.until<now)a={count:0,until:now+60000};if(a.count>=8)bad('Too many attempts. Try again in a minute.',429);const data=await readJson(req);if(typeof data.password!=='string'||!secureCompare(data.password,password)){a.count++;attempts.set(ip,a);bad('Incorrect password',401);}attempts.delete(ip);const t=randomBytes(32).toString('hex');sessions.set(t,now+8*3600000);res.setHeader('Set-Cookie',cookie(t,28800));return json(res,200,{authenticated:true});}
 if(p==='/api/auth/session'&&method==='GET')return json(res,200,{authenticated:!!session(req)});
 if(p==='/api/auth/logout'&&method==='POST'){sessions.delete(session(req));res.setHeader('Set-Cookie',cookie('',0));return json(res,200,{authenticated:false});}
 if(p==='/api/posts'&&method==='GET')return json(res,200,listPosts(url));
 if(p==='/api/admin/posts'&&method==='GET'){auth(req);return json(res,200,listPosts(url,true));}
 const adminMatch=p.match(/^\/api\/admin\/posts\/(\d+)$/);if(adminMatch&&method==='GET'){auth(req);const post=postById(Number(adminMatch[1]));if(!post)bad('Post not found',404);return json(res,200,post);}
 if(p==='/api/posts'&&method==='POST'){auth(req);const v=validate(await readJson(req));if(db.prepare('SELECT id FROM posts WHERE slug=?').get(v.slug))bad('Slug already exists',409);const r=db.prepare("INSERT INTO posts(title,slug,excerpt,body,category,status,published_at) VALUES(?,?,?,?,?,?,CASE WHEN ?='published' THEN CURRENT_TIMESTAMP END)").run(v.title,v.slug,v.excerpt,v.body,v.category,v.status,v.status);return json(res,201,postById(Number(r.lastInsertRowid)));}
 const match=p.match(/^\/api\/posts\/([^/]+)$/);
 if(match&&method==='GET'){const post=db.prepare("SELECT * FROM posts WHERE slug=? AND status='published'").get(decodeURIComponent(match[1]));if(!post)bad('Post not found',404);return json(res,200,post);}
 if(match&&['PATCH','DELETE'].includes(method)){auth(req);if(!/^\d+$/.test(match[1]))bad('Use numeric post ID',400);const id=Number(match[1]);const old=postById(id);if(!old)bad('Post not found',404);if(method==='DELETE'){db.prepare('DELETE FROM posts WHERE id=?').run(id);return json(res,200,{deleted:true});}const v=validate({...old,...await readJson(req)});if(db.prepare('SELECT id FROM posts WHERE slug=? AND id<>?').get(v.slug,id))bad('Slug already exists',409);db.prepare("UPDATE posts SET title=?,slug=?,excerpt=?,body=?,category=?,status=?,updated_at=CURRENT_TIMESTAMP,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE NULL END WHERE id=?").run(v.title,v.slug,v.excerpt,v.body,v.category,v.status,v.status,id);return json(res,200,postById(id));}
 if(p.startsWith('/api/'))bad('Endpoint not found',404);
 if(method!=='GET'&&method!=='HEAD')bad('Method not allowed',405);
 const file=files[p]||(/^\/blog\/[^/]+$/.test(p)?'blog.html':null);if(!file)bad('Page not found',404);const body=readFileSync(resolve(root,'public',file));res.writeHead(200,{'Content-Type':types[file.split('.').pop()]});res.end(method==='HEAD'?undefined:body);
 }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'Unexpected server error'});else res.end();if(!e.status)console.error(e);}});
server.listen(port,()=>{console.log(`Tactyqal demo running on port ${server.address().port}`);if(!production&&!process.env.ADMIN_PASSWORD)console.log('Local-only demo password: tactyqal-local-demo');});
