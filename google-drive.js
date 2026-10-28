'use strict';

const fs=require('fs'),path=require('path'),crypto=require('crypto');

function createGoogleDrive({dataDir,clientId,clientSecret,redirectUri}){
 const tokenFile=path.join(dataDir,'google-drive-tokens.json'),pending=new Map();
 const configured=()=>Boolean(clientId&&clientSecret&&redirectUri);
 function readTokens(){try{return JSON.parse(fs.readFileSync(tokenFile,'utf8'))}catch(e){if(e.code==='ENOENT')return{accounts:{}};throw e}}
 function writeTokens(tokens){
  const tmp=tokenFile+'.tmp',fd=fs.openSync(tmp,'w',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(tokens,null,2));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  fs.renameSync(tmp,tokenFile);fs.chmodSync(tokenFile,0o600);
 }
 function status(){
  const tokens=readTokens();
  return{configured:configured(),accounts:[1,2].map(slot=>{const a=tokens.accounts[String(slot)];return{slot,connected:Boolean(a?.refresh_token),email:a?.email||null,lastBackup:a?.lastBackup||null,lastError:a?.lastError||null}}),lastRun:tokens.lastRun||null};
 }
 function beginConnect(slot){
  if(!configured())throw Error('Google Drive OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.');
  if(slot!==1&&slot!==2)throw Error('Drive account slot must be 1 or 2.');
  const state=crypto.randomBytes(32).toString('hex'),verifier=crypto.randomBytes(32).toString('base64url');
  pending.set(state,{slot,verifier,expiresAt:Date.now()+10*60*1000});
  const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [k,v] of Object.entries({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:'openid email https://www.googleapis.com/auth/drive.file',access_type:'offline',prompt:'consent select_account',state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))u.searchParams.set(k,v);
  return u.toString();
 }
 async function finishConnect(state,code){
  const flow=pending.get(state);pending.delete(state);
  if(!flow||flow.expiresAt<Date.now())throw Error('Google sign-in expired or state did not match. Start the connection again.');
  const body=new URLSearchParams({client_id:clientId,client_secret:clientSecret,code,code_verifier:flow.verifier,grant_type:'authorization_code',redirect_uri:redirectUri});
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  const tokens=await response.json();
  if(!response.ok||!tokens.refresh_token)throw Error(`Google token exchange failed: ${tokens.error_description||tokens.error||response.statusText}`);
  const userResponse=await fetch('https://www.googleapis.com/oauth2/v2/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`}});
  const user=await userResponse.json();
  if(!userResponse.ok||!user.email)throw Error(`Could not verify the Google account email: ${user.error?.message||userResponse.statusText}`);
  const all=readTokens(),other=all.accounts[String(flow.slot===1?2:1)];
  if(other?.email&&other.email.toLowerCase()===user.email.toLowerCase())throw Error('Connect a different Google account in each Drive slot.');
  all.accounts[String(flow.slot)]={email:user.email,refresh_token:tokens.refresh_token,access_token:tokens.access_token,expires_at:Date.now()+(tokens.expires_in||3600)*1000};
  writeTokens(all);
  return{slot:flow.slot,email:user.email};
 }
 async function accessToken(slot){
  if(!configured())throw Error('Google Drive OAuth is not configured.');
  const all=readTokens(),account=all.accounts[String(slot)];
  if(!account?.refresh_token)throw Error(`Google Drive account ${slot} is not connected.`);
  if(account.access_token&&account.expires_at>Date.now()+60000)return account.access_token;
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:account.refresh_token,grant_type:'refresh_token'})});
  const refreshed=await response.json();
  if(!response.ok||!refreshed.access_token)throw Error(`Google access-token refresh failed for ${account.email}: ${refreshed.error_description||refreshed.error||response.statusText}`);
  account.access_token=refreshed.access_token;account.expires_at=Date.now()+(refreshed.expires_in||3600)*1000;all.accounts[String(slot)]=account;writeTokens(all);
  return account.access_token;
 }
 async function driveRequest(token,url,options={}){
  const response=await fetch(url,{...options,headers:{Authorization:`Bearer ${token}`,...options.headers}});
  const text=await response.text();let data={};try{data=text?JSON.parse(text):{}}catch{}
  if(!response.ok)throw Error(`Google Drive request failed (${response.status}): ${data.error?.message||text||response.statusText}`);
  return data;
 }
 const escapeQuery=s=>s.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
 async function findFolder(token,name,parent){
  const q=`name='${escapeQuery(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parent?` and '${escapeQuery(parent)}' in parents`:''}`;
  const result=await driveRequest(token,`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=100&fields=files(id,name)`);
  if(result.files?.length)return result.files[0].id;
  const folder=await driveRequest(token,'https://www.googleapis.com/drive/v3/files?fields=id,name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',...(parent?{parents:[parent]}:{})})});
  return folder.id;
 }
 async function upload(slot,filename,bytes){
  const token=await accessToken(slot),all=readTokens(),account=all.accounts[String(slot)];
  let parent=await findFolder(token,'Binding Wire Label Studio');
  parent=await findFolder(token,'Backups',parent);
  const date=/(\d{4})-(\d{2})-(\d{2})/.exec(filename)||(()=>{const d=new Date();return[d.toISOString(),d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')]})();
  parent=await findFolder(token,date[1],parent);parent=await findFolder(token,date[2],parent);
  const q=`name='${escapeQuery(filename)}' and '${escapeQuery(parent)}' in parents and trashed=false`;
  const existing=await driveRequest(token,`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1&fields=files(id)`);
  const metadata=JSON.stringify({name:filename,mimeType:'application/octet-stream',...(existing.files?.[0]?{}:{parents:[parent]})});
  const endpoint=existing.files?.[0]?`https://www.googleapis.com/upload/drive/v3/files/${existing.files[0].id}?uploadType=resumable&fields=id,name,webViewLink`:'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink';
  const init=await fetch(endpoint,{method:existing.files?.[0]?'PATCH':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':'application/octet-stream','X-Upload-Content-Length':String(bytes.length)},body:metadata});
  const initText=await init.text();let initResult={};try{initResult=initText?JSON.parse(initText):{}}catch{}
  if(!init.ok)throw Error(`Google Drive upload setup failed (${init.status}): ${initResult.error?.message||initText||init.statusText}`);
  const location=init.headers.get('location');
  if(!location)throw Error('Google Drive did not return a resumable upload URL.');
  const session=new URL(location);
  if(!['www.googleapis.com','upload.googleapis.com'].includes(session.hostname))throw Error('Google Drive returned an unexpected upload host.');
  const uploaded=await fetch(session,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream'},body:bytes});
  const uploadedText=await uploaded.text();let result={};try{result=uploadedText?JSON.parse(uploadedText):{}}catch{}
  if(!uploaded.ok)throw Error(`Google Drive upload failed (${uploaded.status}): ${result.error?.message||uploadedText||uploaded.statusText}`);
  all.accounts[String(slot)]={...account,lastBackup:{file:filename,at:new Date().toISOString(),id:result.id}};
  delete all.accounts[String(slot)].lastError;writeTokens(all);
  return{slot,email:account.email,file:filename,id:result.id,webViewLink:result.webViewLink||null};
 }
 async function children(token,parent,query=''){
  const files=[];let pageToken='';
  do{
   const q=`'${escapeQuery(parent)}' in parents and trashed=false${query?` and ${query}`:''}`;
   const params=new URLSearchParams({q,pageSize:'1000',fields:'nextPageToken,files(id,name,mimeType,modifiedTime,size)',...(pageToken?{pageToken}:{})});
   const page=await driveRequest(token,`https://www.googleapis.com/drive/v3/files?${params}`);
   files.push(...(page.files||[]));pageToken=page.nextPageToken||'';
  }while(pageToken);
  return files;
 }
 async function listBackups(slot){
  const token=await accessToken(slot);
  const root=await findFolder(token,'Binding Wire Label Studio'),backups=await findFolder(token,'Backups',root),result=[];
  for(const year of await children(token,backups,"mimeType='application/vnd.google-apps.folder'")){
   for(const month of await children(token,year.id,"mimeType='application/vnd.google-apps.folder'")){
    for(const file of await children(token,month.id,"name contains '.sqlite'")){
     if(file.name.startsWith('labels-')&&file.name.endsWith('.sqlite'))result.push({id:file.id,name:file.name,modifiedTime:file.modifiedTime||null,size:+file.size||0,slot});
    }
   }
  }
  return result.sort((a,b)=>String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
 }
 async function downloadBackup(slot,id){
  const file=(await listBackups(slot)).find(item=>item.id===id);
  if(!file)throw Error('That file is not in this app’s Google Drive backup folders.');
  if(file.size>250*1024*1024)throw Error('The selected Drive backup exceeds the 250 MB restore limit.');
  const token=await accessToken(slot),response=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)throw Error(`Google Drive download failed (${response.status}): ${await response.text()||response.statusText}`);
  const declared=Number(response.headers.get('content-length')||0);
  if(declared>250*1024*1024)throw Error('The selected Drive backup exceeds the 250 MB restore limit.');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>250*1024*1024)throw Error('The selected Drive backup exceeds the 250 MB restore limit.');
  return{name:file.name,bytes};
 }
 function recordRun(results){
  const all=readTokens(),at=new Date().toISOString();
  for(const result of results){
   const account=all.accounts[String(result.slot)];
   if(account){if(result.ok){delete account.lastError;account.lastBackup={...account.lastBackup,at}}else account.lastError=result.error}
  }
  all.lastRun={at,results};writeTokens(all);
 }
 return{configured,status,beginConnect,finishConnect,upload,listBackups,downloadBackup,recordRun};
}

module.exports={createGoogleDrive};
