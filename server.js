'use strict';
// Binding Wire Label Studio - local server. SQLite runs through sql.js (WebAssembly); the database file is data/labels.sqlite.
// Concurrency model: ONE process owns the database and every request handler is synchronous, so writers can never interleave
// (serial execution = serializable). sql.js keeps the database in memory, so SQLite's own WAL/file locking does not apply;
// durability comes from atomic file replacement (write temp -> fsync -> rename) after every committed transaction.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {createGoogleDrive}=require('./google-drive');
const {createLabelDocx}=require('./label-docx');
function loadEnvFile(file){
 if(!fs.existsSync(file))return;
 for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
  const m=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if(!m||m[2].startsWith('#')||Object.prototype.hasOwnProperty.call(process.env,m[1]))continue;
  let value=m[2];
  if((value[0]==='"'&&value.at(-1)==='"')||(value[0]==="'"&&value.at(-1)==="'"))value=value.slice(1,-1);
  else value=value.replace(/\s+#.*$/,'').trim();
  process.env[m[1]]=value;
 }
}
loadEnvFile(path.join(__dirname,'.env'));
const PORT=+process.env.PORT||3001,HOST=process.env.HOST||'127.0.0.1';
const D=path.join(__dirname,'data'),F=path.join(D,'labels.sqlite'),BK=path.join(D,'backups'),PUB=path.join(__dirname,'public');
const B32='0123456789ABCDEFGHJKMNPQRSTVWXYZ',DATE=/^\d{4}-\d{2}-\d{2}$/,now=()=>new Date().toISOString();
const DRIVE_BACKUP_TIME=process.env.DRIVE_BACKUP_TIME||'23:00';
if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(DRIVE_BACKUP_TIME))throw Error('DRIVE_BACKUP_TIME must be HH:MM in local time.');
const DRIVE_REDIRECT_URI=process.env.GOOGLE_OAUTH_REDIRECT_URI||`http://127.0.0.1:${PORT}/api/drive/callback`;
const DRIVE=createGoogleDrive({dataDir:D,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,clientSecret:process.env.GOOGLE_OAUTH_CLIENT_SECRET,
 redirectUri:DRIVE_REDIRECT_URI});
const localHostname=h=>h==='localhost'||h==='127.0.0.1'||h==='::1'||h==='[::1]';
const DRIVE_LOCAL_CALLBACK=localHostname(new URL(DRIVE_REDIRECT_URI).hostname);
const err=(code,msg)=>Object.assign(new Error(msg),{code});
const okDate=d=>DATE.test(d||'')&&!isNaN(Date.parse(d))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
fs.mkdirSync(BK,{recursive:true});

/* ---- one server per data folder ---- */
const LK=path.join(D,'.lock');
try{fs.writeFileSync(LK,String(process.pid),{flag:'wx'})}catch{
 const pid=+fs.readFileSync(LK,'utf8');let alive=false;try{process.kill(pid,0);alive=pid!==process.pid}catch{}
 if(alive){console.error(`Another server (pid ${pid}) already uses this data folder. Close it first.`);process.exit(1)}
 fs.writeFileSync(LK,String(process.pid))}
process.on('exit',()=>{try{fs.unlinkSync(LK)}catch{}});
for(const s of['SIGINT','SIGTERM'])process.on(s,()=>process.exit(0));

/* ---- database layer ---- */
let SQL,db;
const open=()=>{db=new SQL.Database(fs.existsSync(F)?fs.readFileSync(F):undefined);db.run('PRAGMA foreign_keys=ON')};
const reload=()=>{try{db.close()}catch{}open()};
const all=(q,p=[])=>{const s=db.prepare(q);try{s.bind(p);const r=[];while(s.step())r.push(s.getAsObject());return r}finally{s.free()}};
const one=(q,p)=>all(q,p)[0];
const latestBatchTag=()=>one('SELECT batch_no FROM batch ORDER BY created_at DESC,id DESC LIMIT 1')?.batch_no||'no-lots';
function persist(){                                         // call ONLY outside a transaction: sql.js export() closes and re-opens the db
 const lot=latestBatchTag();
 const bytes=Buffer.from(db.export()),tmp=F+'.tmp',fd=fs.openSync(tmp,'w');
 try{fs.writeSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 fs.renameSync(tmp,F);                                      // atomic replace: a crash leaves the old or the new file, never half of each
 try{const d=fs.openSync(D,'r');fs.fsyncSync(d);fs.closeSync(d)}catch{}
 db.run('PRAGMA foreign_keys=ON');                          // export() reset the pragmas
 const b=path.join(BK,`labels-${now().slice(0,10)}-lot-${lot}.sqlite`);
 if(!fs.existsSync(b)){fs.copyFileSync(F,b);for(const x of fs.readdirSync(BK).filter(n=>/^labels-\d{4}-\d\d-\d\d-lot-.*\.sqlite$/.test(n)).sort().slice(0,-14))fs.unlinkSync(path.join(BK,x))}   // daily snapshots, keep 14
}
function tx(f){                                             // ACID unit: BEGIN IMMEDIATE ... COMMIT, then durable file write
 db.run('BEGIN IMMEDIATE');
 let r;try{r=f();db.run('COMMIT')}catch(e){try{db.run('ROLLBACK')}catch{}throw e}
 try{persist()}catch(e){reload();throw err(500,'Could not write data/labels.sqlite: '+e.message)}   // memory never runs ahead of disk
 return r;
}
function migrate(save=true){
 let version=one('PRAGMA user_version').user_version;
 if(version<1){db.exec(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));version=2;if(save)persist()}
 if(version>2)throw Error(`Database schema v${version} is newer than this app supports (v2).`);
 if(version<2){
  db.run('BEGIN IMMEDIATE');
  try{
   db.exec(`CREATE TABLE batch_label(id INTEGER PRIMARY KEY AUTOINCREMENT,batch_id INTEGER NOT NULL REFERENCES batch(id),sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 500),created_at TEXT NOT NULL,UNIQUE(batch_id,sequence_no)) STRICT;
    CREATE INDEX ix_label_batch ON batch_label(batch_id,sequence_no);
    CREATE TRIGGER label_append_only_u BEFORE UPDATE ON batch_label BEGIN SELECT RAISE(ABORT,'label sequence is append-only'); END;
    CREATE TRIGGER label_append_only_d BEFORE DELETE ON batch_label BEGIN SELECT RAISE(ABORT,'label sequence is append-only'); END;`);
   for(const b of all('SELECT batch_id,MAX(qty) max_qty,MIN(printed_at) printed_at FROM print_job GROUP BY batch_id')){
    for(let n=1;n<=b.max_qty;n++)db.run('INSERT INTO batch_label(batch_id,sequence_no,created_at) VALUES(?,?,?)',[b.batch_id,n,b.printed_at]);
   }
   db.exec(`DROP VIEW v_batch;
    CREATE VIEW v_batch AS
    SELECT b.id,b.uid,b.batch_no,b.mfg_date,b.serial,b.status,b.note,b.version,b.created_at,b.updated_at,
           p.id AS product_id,p.title,p.size,p.weight,p.quality,p.coil,
           (SELECT COALESCE(SUM(qty),0) FROM print_job j WHERE j.batch_id=b.id) AS labels,
           (SELECT COALESCE(MAX(sequence_no),0) FROM batch_label l WHERE l.batch_id=b.id) AS label_count,
           (SELECT COUNT(*) FROM print_job j WHERE j.batch_id=b.id) AS jobs,
           (SELECT MAX(printed_at) FROM print_job j WHERE j.batch_id=b.id) AS last_printed
    FROM batch b JOIN product p ON p.id=b.product_id;
    PRAGMA user_version=2;`);
   db.run('COMMIT');version=2;
  }catch(e){try{db.run('ROLLBACK')}catch{}throw e}
  if(save)persist();
 }
}
function migrateThreeColumnDefault(){
 if(one("SELECT value FROM setting WHERE key='three_column_layout_migrated'"))return;
 tx(()=>{
  const previousDefault=one("SELECT value FROM setting WHERE key='three_column_default_migrated'");
  const saved=one("SELECT value FROM setting WHERE key='layout'");
  if(saved){
   const layout=JSON.parse(saved.value);
   if(Number(layout.cols)===2){
    layout.cols='3';
    if(Number(layout.rows)===4)layout.rows='10';
   }else if(previousDefault&&Number(layout.cols)===3&&Number(layout.rows)===4){
    layout.rows='10';
   }
   db.run("UPDATE setting SET value=? WHERE key='layout'",[JSON.stringify(layout)]);
  }
  db.run("INSERT INTO setting(key,value) VALUES('three_column_layout_migrated','1')");
 });
}
const health=()=>({sqlite:one('SELECT sqlite_version() v').v,schema:one('PRAGMA user_version').user_version,
 integrity:all('PRAGMA integrity_check').map(r=>r.integrity_check).join(','),fkViolations:all('PRAGMA foreign_key_check').length,
 pages:one('PRAGMA page_count').page_count,pageSize:one('PRAGMA page_size').page_size,fileBytes:fs.existsSync(F)?fs.statSync(F).size:0,
 backups:fs.readdirSync(BK).sort().reverse()});
function safeWrite(file,bytes){
 const tmp=file+'.tmp',fd=fs.openSync(tmp,'w');
 try{fs.writeSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 fs.renameSync(tmp,file);
}
function makeBackup(kind){
 persist();
 const at=now(),stamp=at.replace(/[:.]/g,'-'),name=kind==='eod'?`labels-eod-${at.slice(0,10)}-lot-${latestBatchTag()}-${stamp}.sqlite`:`labels-manual-lot-${latestBatchTag()}-${stamp}.sqlite`,file=path.join(BK,name);
 fs.copyFileSync(F,file);
 if(kind==='eod')for(const x of fs.readdirSync(BK).filter(n=>/^labels-eod-\d{4}-\d\d-\d\d-lot-.*\.sqlite$/.test(n)).sort().reverse().slice(14))fs.unlinkSync(path.join(BK,x));
 return{file,name};
}
function checkDatabase(){
 const integrity=all('PRAGMA integrity_check').map(r=>r.integrity_check).join(',');
 const fk=all('PRAGMA foreign_key_check').length;
 if(integrity!=='ok'||fk)throw Error(`Backup validation failed: integrity=${integrity}; foreign-key violations=${fk}.`);
}
function validateBackup(bytes){
 const live=db;let candidate;
 try{
  candidate=new SQL.Database(bytes);db=candidate;db.run('PRAGMA foreign_keys=ON');
  checkDatabase();
  const version=one('PRAGMA user_version').user_version;
  if(version<1||version>2)throw Error(`Backup schema v${version} is not supported by this app.`);
  migrate(false);checkDatabase();
  return Buffer.from(db.export());
 }finally{
  if(db!==live){try{db.close()}catch{}}
  db=live;
 }
}
function restoreBackup(name){
 if(typeof name!=='string'||path.basename(name)!==name||!/^labels-.*\.sqlite$/.test(name))throw err(400,'Choose a valid backup file.');
 const source=path.join(BK,name);if(!fs.existsSync(source))throw err(404,'The selected backup no longer exists.');
 const stat=fs.lstatSync(source);
 if(!stat.isFile()||stat.isSymbolicLink())throw err(400,'The selected backup is not a regular file.');
 const restored=validateBackup(fs.readFileSync(source));
 persist();
 const stamp=now().replace(/[:.]/g,'-'),emergency=`labels-pre-restore-lot-${latestBatchTag()}-${stamp}.sqlite`;
 fs.copyFileSync(F,path.join(BK,emergency));
 const previous=fs.readFileSync(F);
 try{
  safeWrite(F,restored);reload();checkDatabase();
 }catch(e){
  safeWrite(F,previous);reload();throw err(500,`Restore failed; the original database was recovered: ${e.message}`);
 }
 return{ok:true,restoredFrom:name,preRestoreBackup:emergency,health:health()};
}
async function restoreBackupRequest(body){
 if(body.driveAccount===undefined)return restoreBackup(body.file);
 const slot=+body.driveAccount,id=String(body.driveId||'');
 if((slot!==1&&slot!==2)||!id)throw err(400,'Choose a valid Google Drive backup.');
 const remote=await DRIVE.downloadBackup(slot,id);
 if(!/^labels-[A-Za-z0-9._-]+\.sqlite$/.test(remote.name))throw err(400,'The selected Drive file has an invalid backup filename.');
 const cached=`labels-drive-${slot}-${remote.name.slice('labels-'.length)}`;
 safeWrite(path.join(BK,cached),remote.bytes);
 return restoreBackup(cached);
}
let driveSyncInProgress=false;
async function backupAndSync(kind){
 if(driveSyncInProgress)throw err(409,'A backup sync is already running.');
 driveSyncInProgress=true;
 try{
  const local=makeBackup(kind),results=[];let status;
  try{status=DRIVE.status()}catch(e){
   console.error('Local backup saved, but Google Drive status could not be read:',e.message);
   return{ok:true,file:local.name,drive:[1,2].map(slot=>({slot,ok:false,error:`Local backup saved; Drive status unavailable: ${e.message}`}))};
  }
  for(const account of status.accounts){
   if(!DRIVE.configured()){results.push({slot:account.slot,ok:false,error:'Google Drive OAuth is not configured.'});continue}
   if(!account.connected){results.push({slot:account.slot,ok:false,error:'Google account is not connected.'});continue}
   try{results.push({...await DRIVE.upload(account.slot,local.name,fs.readFileSync(local.file)),ok:true})}
   catch(e){console.error(`Google Drive backup failed for account ${account.slot}:`,e.message);results.push({slot:account.slot,email:account.email,ok:false,error:e.message})}
  }
  let warning;
  try{DRIVE.recordRun(results)}catch(e){warning=`Backup files were created, but sync status could not be recorded: ${e.message}`;console.error(warning)}
  return{ok:true,file:local.name,drive:results,...(warning?{warning}:{})};
 }finally{driveSyncInProgress=false}
}
function uid(){                                             // time-ordered id whose timestamp never goes backwards (kept in the db, so it survives restarts and rollbacks)
 const r=one("SELECT value FROM setting WHERE key='last_ts'");let t=Math.max(Date.now(),(r?+r.value:0)+1),s='';
 db.run("INSERT INTO setting VALUES('last_ts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[String(t)]);
 for(let i=0;i<10;i++){s=B32[t%32]+s;t=Math.floor(t/32)}for(const b of crypto.randomBytes(16))s+=B32[b%32];return s}

/* ---- business logic ---- */
const lab=l=>{const o={};for(const k of['title','size','weight','quality','coil']){const v=String(l?.[k]??'').trim();if(!v||v.length>60)throw err(400,`Label field "${k}" is required (max 60 characters)`);o[k]=v}return o};
const specOf=b=>({title:b.title,size:b.size,coil:b.coil,quality:b.quality,weight:b.weight});
function day(date){
 if(!okDate(date))throw err(400,'date must be a real date, YYYY-MM-DD');
 const out={};for(const b of all('SELECT * FROM v_batch WHERE mfg_date=?',[date]))
  out[b.batch_no]={uid:b.uid,date:b.mfg_date,serial:b.serial,status:b.status,labelCount:b.label_count,spec:specOf(b),prints:[{at:b.last_printed,qty:b.labels}]};
 return out}
function print(b){
 const l=lab(b.label),items=b.items;
 if(!Array.isArray(items)||!items.length||items.length>50)throw err(400,'1 to 50 batches per print');
 for(const i of items)if(!okDate(i.date)||!(i.serial>=1&&i.serial<=99)||!(i.qty>=1&&i.qty<=500))throw err(400,'Bad batch or quantity');
 const start=Math.max(1,Math.min(100,+b.start||1)),at=now();
 return tx(()=>{
  let pid;const prod=()=>pid??=(db.run('INSERT OR IGNORE INTO product(title,size,weight,quality,coil) VALUES(?,?,?,?,?)',[l.title,l.size,l.weight,l.quality,l.coil]),
   one('SELECT id FROM product WHERE title=? AND size=? AND weight=? AND quality=? AND coil=?',[l.title,l.size,l.weight,l.quality,l.coil]).id);
  const done=[];
  for(const i of items){
   let r=one('SELECT id,batch_no FROM batch WHERE mfg_date=? AND serial=?',[i.date,i.serial]);
   if(!r){db.run('INSERT INTO batch(uid,mfg_date,serial,product_id,created_at,updated_at) VALUES(?,?,?,?,?,?)',[uid(),i.date,i.serial,prod(),at,at]);
          r=one('SELECT id,batch_no FROM batch WHERE mfg_date=? AND serial=?',[i.date,i.serial])}   // existing batch = reprint with its ORIGINAL product
   db.run('WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?) INSERT OR IGNORE INTO batch_label(batch_id,sequence_no,created_at) SELECT ?,n,? FROM seq',[i.qty,r.id,at]);
   db.run('INSERT INTO print_job(batch_id,qty,start_pos,printed_at) VALUES(?,?,?,?)',[r.id,i.qty|0,start,at]);done.push(r.batch_no)}
  if(b.layout)db.run("INSERT INTO setting VALUES('layout',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(b.layout).slice(0,2000)]);
  return{ok:true,batches:done}})}
function list(q){                                           // keyset (seek) pagination on (mfg_date DESC, serial DESC)
 const w=[],p=[],s=(q.q||'').trim();
 if(s){const l='%'+s.replace(/[\\%_]/g,'\\$&')+'%';w.push("(batch_no LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR size LIKE ? ESCAPE '\\' OR IFNULL(note,'') LIKE ? ESCAPE '\\')");p.push(l,l,l,l)}
 if(DATE.test(q.from||'')){w.push('mfg_date>=?');p.push(q.from)}
 if(DATE.test(q.to||'')){w.push('mfg_date<=?');p.push(q.to)}
 if(+q.product){w.push('product_id=?');p.push(+q.product)}
 if(q.status==='active'||q.status==='void'){w.push('status=?');p.push(q.status)}
 const where=w.length?' WHERE '+w.join(' AND '):'',total=one('SELECT COUNT(*) n FROM v_batch'+where,p).n;
 const lim=Math.min(100,Math.max(5,+q.limit||20)),c=(q.after||'').split('|'),seek=DATE.test(c[0])&&+c[1]?(where?' AND ':' WHERE ')+'(mfg_date,serial)<(?,?)':'';
 const rows=all('SELECT * FROM v_batch'+where+seek+' ORDER BY mfg_date DESC,serial DESC LIMIT '+(lim+1),seek?[...p,c[0],+c[1]]:p);
 const more=rows.length>lim;if(more)rows.pop();const last=rows[rows.length-1];
 return{total,rows,next:more&&last?`${last.mfg_date}|${last.serial}`:null}}
function detail(id){
 const b=one('SELECT * FROM v_batch WHERE id=?',[id]);if(!b)throw err(404,'No such batch');
 return{batch:b,jobs:all('SELECT qty,start_pos,printed_at FROM print_job WHERE batch_id=? ORDER BY id DESC',[id]),
  versions:all('SELECT version,status,note,valid_from,valid_to FROM batch_version WHERE batch_id=? ORDER BY version DESC',[id])}}
function patch(id,b){                                       // optimistic concurrency: succeeds only if nobody changed the row since you read it
 if(b.status!==undefined&&b.status!=='active'&&b.status!=='void')throw err(400,'status must be active or void');
 return tx(()=>{
  db.run('UPDATE batch SET status=COALESCE(?,status),note=CASE WHEN ? THEN ? ELSE note END,version=version+1,updated_at=? WHERE id=? AND version=?',
   [b.status??null,b.note!==undefined?1:0,b.note===undefined?null:String(b.note).slice(0,200),now(),id,+b.version]);
  if(!db.getRowsModified())throw err(409,'This batch was changed by someone else - reload and try again');
  return detail(id)})}
const stats=()=>({
 totals:one("SELECT (SELECT COUNT(*) FROM batch) batches,(SELECT COUNT(*) FROM batch WHERE status='void') voided,(SELECT COALESCE(SUM(qty),0) FROM print_job) labels,(SELECT COUNT(*) FROM print_job) jobs,(SELECT COUNT(*) FROM product) products,(SELECT COALESCE(SUM(qty),0) FROM print_job WHERE substr(printed_at,1,10)=date('now')) today"),
 daily:all("SELECT d,n,SUM(n) OVER(ORDER BY d) AS cum FROM(SELECT substr(printed_at,1,10) d,SUM(qty) n FROM print_job WHERE printed_at>=date('now','-29 day') GROUP BY d) ORDER BY d"),
 products:all("SELECT p.id,p.title||' / '||p.size||' / '||p.weight AS name,COUNT(DISTINCT b.id) batches,COALESCE(SUM(j.qty),0) labels FROM product p LEFT JOIN batch b ON b.product_id=p.id LEFT JOIN print_job j ON j.batch_id=b.id GROUP BY p.id ORDER BY labels DESC")});

/* ---- http ---- */
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
const send=(res,c,b,t='application/json',h={})=>{res.writeHead(c,{'Content-Type':t+'; charset=utf-8','Cache-Control':'no-store',...h});res.end(Buffer.isBuffer(b)||typeof b==='string'?b:JSON.stringify(b))};
async function route(req,body){
 const u=new URL(req.url,'http://x'),q=Object.fromEntries(u.searchParams),m=req.method,p=u.pathname;let r;
 if(m==='GET'&&p==='/api/day')return day(q.date);
 if(m==='GET'&&p==='/api/settings'){const s=one("SELECT value FROM setting WHERE key='layout'");return{layout:s?JSON.parse(s.value):null}}
 if(m==='POST'&&p==='/api/docx')return createLabelDocx(body);
 if(m==='GET'&&p==='/api/drive/status')return{...DRIVE.status(),schedule:DRIVE_BACKUP_TIME,localCallback:DRIVE_LOCAL_CALLBACK};
 if(m==='GET'&&p==='/api/drive/backups'){const slot=Number(q.account);if(slot!==1&&slot!==2)throw err(400,'Drive account must be 1 or 2.');return DRIVE.listBackups(slot)}
 if(m==='POST'&&p==='/api/print')return print(body);
 if(m==='POST'&&p==='/api/restore')return restoreBackupRequest(body);
 if(m==='GET'&&p==='/api/batches')return list(q);
 if(m==='GET'&&p==='/api/products')return all('SELECT id,title,size,weight FROM product ORDER BY title,size');
 if((r=/^\/api\/batches\/(\d+)$/.exec(p))){if(m==='GET')return detail(+r[1]);if(m==='PATCH')return patch(+r[1],body)}
 if(m==='GET'&&p==='/api/stats')return stats();
 if(m==='GET'&&p==='/api/health')return health();
 if(m==='POST'&&p==='/api/backup')return backupAndSync('manual');
 throw err(404,'Not found')}
const escHtml=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function serve(req,res){
 try{
  const o=req.headers.origin;if(o&&new URL(o).host!==req.headers.host)return send(res,403,{error:'Forbidden'});
  const u=new URL(req.url,'http://x'),p=u.pathname;
  if(req.method==='GET'&&p==='/api/drive/connect'){
   if(DRIVE_LOCAL_CALLBACK){
    const requestHost=new URL(`http://${req.headers.host||''}`).hostname;
    if(!localHostname(requestHost))throw err(400,'Connect Google Drive from a browser on the server computer at http://127.0.0.1:'+PORT+'.');
   }
   const location=DRIVE.beginConnect(Number(u.searchParams.get('account')));
   res.writeHead(302,{Location:location,'Cache-Control':'no-store'});return res.end();
  }
  if(req.method==='GET'&&p==='/api/drive/callback'){
   (async()=>{
    try{
     if(u.searchParams.get('error'))throw Error(`Google sign-in failed: ${u.searchParams.get('error_description')||u.searchParams.get('error')}`);
     const connected=await DRIVE.finishConnect(u.searchParams.get('state'),u.searchParams.get('code'));
     send(res,200,`<!doctype html><meta charset="utf-8"><title>Drive connected</title><p>Google Drive account ${connected.slot} connected: <b>${escHtml(connected.email)}</b>.</p><p><a href="/insights.html">Return to Insights</a></p>`,'text/html');
    }catch(e){send(res,400,`<!doctype html><meta charset="utf-8"><title>Drive connection failed</title><p>Google Drive connection failed: ${escHtml(e.message)}</p><p><a href="/insights.html">Return to Insights</a></p>`,'text/html')}
   })();
   return;
  }
  if(req.method==='GET'&&p==='/api/download')return send(res,200,fs.readFileSync(F),'application/octet-stream',{'Content-Disposition':`attachment; filename="labels-database-lot-${latestBatchTag()}-${now().replace(/[:.]/g,'-')}.sqlite"`});
  if(req.method==='GET'&&!p.startsWith('/api/')){
   const f=path.join(PUB,p==='/'?'index.html':p.slice(1)),ok=path.normalize(f).startsWith(PUB)&&fs.existsSync(f)&&fs.statSync(f).isFile();
   return ok?send(res,200,fs.readFileSync(f),MIME[path.extname(f)]||'application/octet-stream'):send(res,404,{error:'Not found'})}
  let s='';req.on('data',c=>{s+=c;if(s.length>1e6)req.destroy()});
  req.on('end',async()=>{try{
   if(req.method!=='GET'&&!/json/.test(req.headers['content-type']||''))throw err(415,'JSON only');
   const result=await route(req,s?JSON.parse(s):{});
   if(req.method==='POST'&&p==='/api/docx'){
    const shown=result.batchNos.slice(0,3),filename=`Labels_${shown.join('_')}${result.batchNos.length>3?`_and_${result.batchNos.length-3}_more`:''}.docx`;
    const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return send(res,200,result.buffer,mime,{'Content-Type':mime,'Content-Disposition':`attachment; filename="${filename}"`});
   }
   send(res,200,result)}
  catch(e){send(res,e.code>=400&&e.code<600?e.code:/constraint|void|immutable|never deleted|append-only/i.test(e.message)?409:500,{error:e.message})}})
 }catch(e){send(res,e.code>=400&&e.code<600?e.code:500,{error:e.message})}}

function scheduleDriveBackup(){
 const [hour,minute]=DRIVE_BACKUP_TIME.split(':').map(Number),next=new Date();
 next.setHours(hour,minute,0,0);if(next<=new Date())next.setDate(next.getDate()+1);
 const timer=setTimeout(async()=>{
  try{
   const result=await backupAndSync('eod');
   console.log(`End-of-day backup saved locally as ${result.file}. Drive results: ${JSON.stringify(result.drive)}`);
  }catch(e){console.error('End-of-day backup failed:',e.message)}
  scheduleDriveBackup();
 },next.getTime()-Date.now());
 timer.unref();
}

(async()=>{
 SQL=await require('sql.js')();open();migrate();migrateThreeColumnDefault();
 const h=health();if(h.integrity!=='ok'||h.fkViolations){console.error('DATABASE PROBLEM - not starting:',h);process.exit(1)}
 http.createServer(serve).listen(PORT,HOST,()=>{console.log(`\n  Label Studio is running ->  http://127.0.0.1:${PORT}\n  Database: ${F}  (SQLite ${h.sqlite}, schema v${h.schema})\n  Daily Google Drive backup: ${DRIVE_BACKUP_TIME} local time.\n  Press Ctrl+C to stop.\n`);scheduleDriveBackup()});
})().catch(e=>{console.error(e);process.exit(1)});
