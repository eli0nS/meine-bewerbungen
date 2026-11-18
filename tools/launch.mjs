import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { npmCommand } from './npm.mjs';
import { appIsRunning, browserAddress, openBrowser } from './browser-start.mjs';
import { setTimeout as delay } from 'node:timers/promises';

process.chdir(fileURLToPath(new URL('..',import.meta.url)));
function run(file,args,message) {
  const result=spawnSync(file,args,{stdio:'inherit'});
  if(result.status!==0) throw new Error(message);
}

try {
  const address=browserAddress(process.env.PORT||49569);
  const own=browserAddress(process.env.ATELIER_LIVE_PORT||49570);
  const [demoRunning,ownRunning]=await Promise.all([appIsRunning(address,'demo'),appIsRunning(own,'live')]);
  if(demoRunning&&ownRunning) {
    console.log(`Meine Bewerbungen läuft bereits. Öffne ${own}.`);
    openBrowser(own);
  } else {
    const marker='node_modules/.bewerbung-install';
    const lock=createHash('sha256').update(readFileSync('package-lock.json')).digest('hex');
    let previous;
    try {previous=readFileSync(marker,'utf8');} catch {}
    if(previous!==lock) {
      console.log('Die App richtet sich beim ersten Start ein. Eine Internetverbindung ist erforderlich.');
      const [npm,...args]=npmCommand();
      run(npm,[...args,'ci','--omit=dev','--no-audit','--no-fund'],'Die App konnte nicht eingerichtet werden. Prüfe die Internetverbindung und starte erneut.');
      writeFileSync(marker,lock);
    }
    run(process.execPath,['node_modules/playwright/cli.js','install','chromium'],'Der Testbrowser konnte nicht eingerichtet werden. Prüfe die Internetverbindung und starte erneut.');
    if(process.argv.includes('--background')) {
      const child=spawn(process.execPath,['server/main.mjs','--both'],{
        detached:true,windowsHide:true,stdio:'ignore',
        env:{...process.env,ATELIER_START_PROVIDER:process.argv.includes('--claude')?'claude':'codex'}
      });
      let failure;
      child.once('error',error=>{failure=error;});
      child.unref();
      for(let attempt=0;attempt<60;attempt++) {
        if(failure||child.exitCode!==null) throw new Error('Der Start ist fehlgeschlagen. Prüfe, ob die lokalen Ports bereits belegt sind.');
        if(await appIsRunning(own,'live')) break;
        await delay(250);
      }
      if(!await appIsRunning(own,'live')) throw new Error('Der Arbeitsbereich antwortet noch nicht.');
      openBrowser(own);
      console.log('Bereit: '+own);
    } else run(process.execPath,['server/main.mjs','--both','--open'],'Die App wurde beendet.');
  }
} catch(error) {
  console.error(error.message);
  process.exitCode=1;
}
