import { spawn } from 'node:child_process';

export function browserAddress(port) {
  return `http://127.0.0.1:${Number(port)}`;
}

export function openBrowser(url) {
  if(process.env.ATELIER_NO_OPEN) return;
  const command=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open';
  const child=spawn(command,[url],{stdio:'ignore',detached:true,windowsHide:true});
  child.on('error',()=>console.log(`Öffne ${url} im Browser.`));
  child.unref();
}

export async function appIsRunning(address,mode) {
  try {
    const response=await fetch(`${address}/health`,{signal:AbortSignal.timeout(1200),redirect:'error'});
    if(!response.ok) return false;
    const result=await response.json();
    return result.app==='meine-bewerbungen'&&result.mode===mode&&result.ready===true;
  } catch { return false; }
}
