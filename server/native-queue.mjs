import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const lifetime=30*60*1000;
const lockPath=(folder,id,type)=>{
  if(!idPattern.test(id)) throw new Error('Ungültige Auftragsnummer.');
  return join(folder,`${id}.${type}.json`);
};

async function loadJson(path) { return JSON.parse(await readFile(path,'utf8')); }
async function remove(path) {
  try { await unlink(path); } catch(error) { if(error.code!=='ENOENT') throw error; }
}
async function writeJson(path,value) {
  const temp=`${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp,JSON.stringify(value),{encoding:'utf8',flag:'wx',mode:0o600});
    await rename(temp,path);
  } finally { await remove(temp); }
}

export async function pendingRequests(folder) {
  let files;
  try { files=await readdir(folder); } catch(error) { if(error.code==='ENOENT')return [];throw error; }
  const requests=[];
  for(const name of files) {
    if(!name.endsWith('.request.json'))continue;
    const id=name.slice(0,-'.request.json'.length);
    if(!idPattern.test(id))continue;
    let item;
    try { item=await loadJson(lockPath(folder,id,'request')); }
    catch(error) { if(error.code==='ENOENT')continue;throw error; }
    if(Date.now()>=item.expiresAt) {
      await remove(lockPath(folder,id,'request')); await remove(lockPath(folder,id,'result'));
      continue;
    }
    if(item.id===id&&!(await nativeResult(folder,id))) requests.push(item.topics?{id,topics:item.topics,place:item.place}:{id,employer:item.context.listing.employer,title:item.context.listing.title});
  }
  return requests;
}

export async function readNativeRequest(folder,id) {
  const item=await loadJson(lockPath(folder,id,'request'));
  if(item.id!==id||Date.now()>=item.expiresAt) throw new Error('Dieser Auftrag ist abgelaufen.');
  return item;
}

export async function nativeResult(folder,id) {
  try { return await loadJson(lockPath(folder,id,'result')); }
  catch(error) { if(error.code==='ENOENT') return null; throw error; }
}

export async function completeNativeRequest(folder,id,result) {
  await readNativeRequest(folder,id);
  if(await nativeResult(folder,id)) throw new Error('Zu diesem Auftrag liegt bereits ein Ergebnis vor.');
  await writeJson(lockPath(folder,id,'result'),result);
}

export function createNativeQueue(folder) {
  const active=new Map();
  const forget=async id=>{
    active.delete(id);
    await Promise.all(['request','result'].map(type=>remove(lockPath(folder,id,type))));
  };
  async function issue(packet,metadata) {
    for(const [id,entry] of active) if(Date.now()>=entry.expiresAt) await forget(id);
    for(const [id,entry] of active) if(entry.target===metadata.target&&entry.hash===metadata.hash) return id;
    if(active.size>=4) throw new Error('Es sind bereits vier Entwürfe in Arbeit. Hole sie ab oder warte, bis ein Auftrag abläuft.');
    const id=randomUUID();
    const expiresAt=Date.now()+lifetime;
    active.set(id,{...metadata,expiresAt});
    try {
      await mkdir(folder,{recursive:true,mode:0o700});
      await writeJson(lockPath(folder,id,'request'),{id,expiresAt,...packet});
    } catch(error) {active.delete(id);throw error;}
    const timer=setTimeout(()=>{void forget(id).catch(()=>{});},lifetime);
    timer.unref();
    return id;
  }
  function get(id) {
    const data=active.get(id);
    if(!data||Date.now()>=data.expiresAt) throw new Error('Dieser Auftrag ist abgelaufen. Starte die Vorbereitung erneut.');
    return data;
  }
  async function result(id) { get(id);return nativeResult(folder,id); }
  const pending=()=>[...active].filter(([,entry])=>Date.now()<entry.expiresAt).map(([id,{target,source}])=>({id,target,source}));
  return {issue,get,result,forget,pending};
}
