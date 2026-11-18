import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from './app.mjs';
import { browserAddress, openBrowser } from '../tools/browser-start.mjs';

const both=process.argv.includes('--both');
const mode=process.argv.includes('--live')?'live':'demo';
const demoPort=Number(process.env.PORT||(both?49569:4317));
const livePort=Number(process.env.ATELIER_LIVE_PORT||49570);
const dataRoot=resolve(process.env.ATELIER_DATA_DIR||join(homedir(),'.bewerbungsatelier'));
const entry={};
const servers=[];

function start(mode,port) {
  return new Promise((resolve,reject)=>{
    const server=createServer();
    server.once('error',reject);
    server.listen(port,'127.0.0.1',()=>{
      try {
        const url=browserAddress(server.address().port);
        const runtime=createApp({dataDir:join(dataRoot,mode),mode,entry});
        runtime.setBase(url);
        entry[mode]=url;
        server.on('request',runtime.app);
        servers.push({server,store:runtime.store});
        resolve();
      } catch(error) {server.close();reject(error);}
    });
  });
}

try {
  if(both) {
    await start('demo',demoPort);
    await start('live',livePort);
  } else await start(mode,Number(process.env.PORT||4317));
  const url=entry[both?'live':mode];
  console.log(`Meine Bewerbungen ist geöffnet.\n${url}\nLass dieses Fenster geöffnet, solange du die App verwendest.`);
  if(process.argv.includes('--open')) openBrowser(url);
} catch(error) {
  const url=`http://127.0.0.1:${both?demoPort:Number(process.env.PORT||4317)}`;
  if(error.code==='EADDRINUSE') console.error(`Die Adresse ${url} wird bereits verwendet. Wenn die App schon läuft, öffne sie dort. Schließe sonst das frühere Startfenster und starte erneut.`);
  else console.error(`Die App konnte nicht starten. ${error.message}`);
  for(const {server,store} of servers) {server.close();store.close();}
  process.exitCode=1;
}
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{
  for(const {server,store} of servers) server.close(()=>store.close());
});
