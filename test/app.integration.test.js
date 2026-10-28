'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const net=require('node:net'),http=require('node:http'),{spawn}=require('node:child_process'),{test}=require('node:test');

async function unusedPort(){
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test('migrates lot counters and safely restores SQLite backups',async t=>{
 const SQL=await require('sql.js')(),root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'bwl-test-'));
 let child;
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){
   const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;
  }
  fs.rmSync(temp,{recursive:true,force:true});
 });
 for(const file of['server.js','schema.sql','google-drive.js'])fs.copyFileSync(path.join(root,file),path.join(temp,file));
 fs.cpSync(path.join(root,'public'),path.join(temp,'public'),{recursive:true});
 fs.mkdirSync(path.join(temp,'data','backups'),{recursive:true});

 const legacy=new SQL.Database();legacy.run('PRAGMA foreign_keys=ON');legacy.exec(fs.readFileSync(path.join(root,'schema.sql'),'utf8'));
 legacy.run("INSERT INTO product(title,size,weight,quality,coil) VALUES('Wire','1mm','1kg','A','C1')");
 legacy.run("INSERT INTO batch(uid,mfg_date,serial,product_id,created_at,updated_at) VALUES('legacy-uid','2026-10-28',1,1,'2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z')");
 legacy.run("INSERT INTO print_job(batch_id,qty,start_pos,printed_at) VALUES(1,3,1,'2026-10-28T00:01:00.000Z')");
 legacy.exec(`DROP VIEW v_batch; DROP TRIGGER label_append_only_u; DROP TRIGGER label_append_only_d; DROP INDEX ix_label_batch; DROP TABLE batch_label;
  CREATE VIEW v_batch AS SELECT b.id,b.uid,b.batch_no,b.mfg_date,b.serial,b.status,b.note,b.version,b.created_at,b.updated_at,p.id AS product_id,p.title,p.size,p.weight,p.quality,p.coil,(SELECT COALESCE(SUM(qty),0) FROM print_job j WHERE j.batch_id=b.id) AS labels,(SELECT COUNT(*) FROM print_job j WHERE j.batch_id=b.id) AS jobs,(SELECT MAX(printed_at) FROM print_job j WHERE j.batch_id=b.id) AS last_printed FROM batch b JOIN product p ON p.id=b.product_id;
  PRAGMA user_version=1;`);
 const legacyBytes=Buffer.from(legacy.export());
 fs.writeFileSync(path.join(temp,'data','labels.sqlite'),legacyBytes);
 fs.writeFileSync(path.join(temp,'data','backups','labels-legacy-v1.sqlite'),legacyBytes);
 legacy.close();

 const port=await unusedPort(),base=`http://127.0.0.1:${port}`;
 fs.writeFileSync(path.join(temp,'.env'),`GOOGLE_OAUTH_CLIENT_ID=test-client-id\nGOOGLE_OAUTH_CLIENT_SECRET=\"test-client-secret\"\nGOOGLE_OAUTH_REDIRECT_URI=${base}/api/drive/callback\n`);
 const env={...process.env,PORT:String(port),HOST:'127.0.0.1',NODE_PATH:path.join(root,'node_modules')};
 delete env.GOOGLE_OAUTH_CLIENT_ID;delete env.GOOGLE_OAUTH_CLIENT_SECRET;delete env.GOOGLE_OAUTH_REDIRECT_URI;
 child=spawn(process.execPath,['server.js'],{cwd:temp,env,stdio:'ignore'});
 let health;
 for(let i=0;i<100;i++){
  try{const response=await fetch(`${base}/api/health`);if(response.ok){health=await response.json();break}}catch{}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(health,'test server should start');
 assert.equal(health.schema,2);
 const day=async()=>await(await fetch(`${base}/api/day?date=2026-10-28`)).json();
 const post=async(route,body)=>fetch(`${base}${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await day())['J2286-01'].labelCount,3,'migration backfills the legacy label count');
 const oldRestore=await post('/api/restore',{file:'labels-legacy-v1.sqlite'});
 assert.equal(oldRestore.status,200,'restore migrates a valid legacy backup before activation');
 assert.equal((await day())['J2286-01'].labelCount,3);
 const backupResponse=await post('/api/backup',{}),backup=await backupResponse.json();
 assert.equal(backupResponse.status,200);

 const print=async qty=>{
  const response=await post('/api/print',{items:[{date:'2026-10-28',serial:1,qty}],label:{title:'Wire',size:'1mm',weight:'1kg',quality:'A',coil:'C1'},start:1});
  assert.equal(response.status,200);
 };
 await print(5);
 assert.equal((await day())['J2286-01'].labelCount,5);
 await print(2);
 assert.equal((await day())['J2286-01'].labelCount,5,'reprints reuse existing per-lot sequence numbers');

 const restoreResponse=await post('/api/restore',{file:backup.file}),restored=await restoreResponse.json();
 assert.equal(restoreResponse.status,200);
 assert.equal(restored.health.integrity,'ok');
 assert.equal((await day())['J2286-01'].labelCount,3);
 assert.ok(fs.existsSync(path.join(temp,'data','backups',restored.preRestoreBackup)));

 const corrupt='labels-corrupt-test.sqlite';
 fs.writeFileSync(path.join(temp,'data','backups',corrupt),'not a SQLite database');
 const failedRestore=await post('/api/restore',{file:corrupt});
 assert.equal(failedRestore.status,500);
 assert.equal((await day())['J2286-01'].labelCount,3,'a failed restore leaves the live database unchanged');

 const download=await fetch(`${base}/api/download`);
 assert.match(download.headers.get('content-disposition'),/lot-J2286-01-/);
 const driveStatus=await(await fetch(`${base}/api/drive/status`)).json();
 assert.equal(driveStatus.schedule,'23:00');
 assert.equal(driveStatus.configured,true,'OAuth credentials load from the private .env file');
 assert.equal(driveStatus.localCallback,true);
 const connect=await fetch(`${base}/api/drive/connect?account=1`,{redirect:'manual'});
 assert.equal(connect.status,302);
 const authorization=new URL(connect.headers.get('location'));
 assert.equal(authorization.searchParams.get('client_id'),'test-client-id');
 assert.equal(authorization.searchParams.get('redirect_uri'),`${base}/api/drive/callback`);
 assert.ok(!connect.headers.get('location').includes('test-client-secret'));
 const remoteConnect=await new Promise((resolve,reject)=>http.get({hostname:'127.0.0.1',port,path:'/api/drive/connect?account=1',headers:{Host:`labels.lan:${port}`}},resolve).on('error',reject));
 remoteConnect.resume();
 assert.equal(remoteConnect.statusCode,400,'localhost OAuth must not redirect a LAN browser back to itself');
 const localBackup=await(await post('/api/backup',{})).json();
 assert.equal(localBackup.drive.length,2);
 assert.ok(localBackup.drive.every(result=>!result.ok&&result.error));
});
