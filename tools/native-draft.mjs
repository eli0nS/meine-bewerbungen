import { homedir } from 'node:os';
import { join,resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { completeNativeRequest, pendingRequests, readNativeRequest } from '../server/native-queue.mjs';
import { handoffSchema } from '../server/agent.mjs';
import { webResults } from '../server/discovery.mjs';
import { appIsRunning, browserAddress } from './browser-start.mjs';

const data=resolve(process.env.ATELIER_DATA_DIR||join(homedir(),'.bewerbungsatelier'));
const args=process.argv.slice(2);
const research=args[0]==='research';
if(research) args.shift();
const folder=join(data,'live',research?'research-inbox':'native-inbox');
const [command,id]=args;

try {
  if(command==='status') {
    const url=browserAddress(process.env.ATELIER_LIVE_PORT||49570);
    console.log(JSON.stringify({running:await appIsRunning(url,'live'),url}));
  } else if(command==='wait') {
    const until=Date.now()+50000;
    let ready=[];
    do {
      ready=await pendingRequests(folder);
      if(ready.length)break;
      await setTimeout(1000);
    } while(Date.now()<until);
    console.log(JSON.stringify(ready));
  } else if(command==='list') {
    console.log(JSON.stringify(await pendingRequests(folder)));
  } else if(command==='read') {
    console.log(JSON.stringify(await readNativeRequest(folder,id||'')));
  } else if(command==='complete') {
    const chunks=[];
    let size=0;
    for await(const chunk of process.stdin) {
      size+=chunk.length;
      if(size>128000) throw new Error('Das Ergebnis ist zu groß.');
      chunks.push(chunk);
    }
    const result=(research?webResults:handoffSchema).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    await completeNativeRequest(folder,id||'',result);
    console.log(research?'Suchergebnisse zur lokalen Prüfung übergeben.':'Entwurf übergeben. Prüfung und Versandentscheidung erfolgen in der Browser-App.');
  } else throw new Error('Verwende status, list, wait, read <id> oder complete <id>.');
} catch(error) {
  console.error(error.code==='ENOENT'?'Auftrag nicht gefunden.':error.message);
  process.exitCode=1;
}
