import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.mjs';
import { makePdf } from '../server/documents.mjs';

const assets='web/anleitung-bilder';
await mkdir(assets,{recursive:true});
const work=await mkdtemp(join(tmpdir(),'anleitung-beispiel-'));
const instances=[];
const entry={};
const browser=await chromium.launch({headless:true});

async function start(mode) {
  const runtime=createApp({dataDir:join(work,mode),mode,entry,headless:true});
  const server=createServer(runtime.app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  entry[mode]=`http://127.0.0.1:${server.address().port}`;
  runtime.setBase(entry[mode]);
  instances.push({server,runtime});
  return runtime;
}

try {
  await start('demo');
  const live=await start('live');
  live.store.addDocument('Musteranschreiben_Beispiel.pdf','sample',await makePdf('Fiktives Musteranschreiben','Ich plane Messreihen und entwickle wiederverwendbare Prüfaufbauten.'));
  const context=await browser.newContext({viewport:{width:1180,height:920},deviceScaleFactor:1,reducedMotion:'reduce'});
  const page=await context.newPage();
  const capture=(selector,name)=>page.locator(selector).screenshot({path:join(assets,name+'.png')});
  await page.goto(entry.live);
  await page.getByRole('heading',{name:'Meine Bewerbungen',exact:true}).waitFor();
  await page.screenshot({path:join(assets,'start.png')});
  await page.getByRole('button',{name:'Lebenslauf hinzufügen'}).click();
  await page.getByLabel('PDF auswählen').setInputFiles({
    name:'Lebenslauf_Beispiel.pdf',mimeType:'application/pdf',
    buffer:Buffer.from(await makePdf('Fiktiver Lebenslauf','Ich plane Messreihen und entwickle Prüfaufbauten.'))
  });
  await page.getByRole('button',{name:'Jetzt Stellen finden'}).waitFor();
  await page.locator('#toast.show').waitFor({state:'hidden'});
  await page.screenshot({path:join(assets,'unterlagen.png')});
  await page.getByRole('button',{name:'Jetzt Stellen finden'}).click();
  await page.getByRole('button',{name:'Stellen nach Lebenslauf suchen'}).waitFor();
  await page.screenshot({path:join(assets,'stellensuche.png')});
  await context.route('**/api/providers/codex',route=>route.fulfill({json:{status:'signed_out',help:'Melde dich im Browser mit deinem ChatGPT-Konto an.',installUrl:'https://learn.chatgpt.com/docs/codex/cli'}}));
  await context.route('**/api/providers/claude',route=>route.fulfill({json:{status:'manual',help:'Öffne dieses Repo in Claude Code und nutze /meine-bewerbungen. Die Anmeldung läuft in Claude Code.',installUrl:'https://code.claude.com/docs/en/setup'}}));
  await page.goto(entry.live+'/#anbieter');
  await page.getByRole('button',{name:/Bei ChatGPT anmelden/}).waitFor();
  await page.getByRole('button',{name:/Claude verwenden/}).waitFor();
  await page.screenshot({path:join(assets,'anbieter.png')});
  await page.goto(entry.live+'/#schreibvorlage');
  await page.getByText('Aktive Vorlage · PDF herunterladen',{exact:true}).waitFor();
  await page.screenshot({path:join(assets,'vorlage.png')});
  await page.goto(entry.demo);
  await page.getByRole('button',{name:/Mit Beispieldaten ausprobieren/}).click();
  await page.getByRole('button',{name:/Beispielstelle suchen/}).click();
  await page.getByRole('heading',{name:'Gefundene Beispielstelle'}).waitFor();
  await capture('.search-results','stellenvorschlag');
  await page.getByRole('button',{name:/Bewerbung vorbereiten/}).click();
  await page.getByText('Faktenprüfung anzeigen',{exact:true}).click();
  await page.getByRole('navigation').getByRole('button',{name:'Start',exact:true}).click();
  await page.locator('#toast.show').waitFor({state:'hidden'});
  await page.screenshot({path:join(assets,'bewerbungsuebersicht.png')});
  await page.getByRole('navigation').getByRole('button',{name:'Bewerbungen',exact:true}).click();
  await page.getByText('Faktenprüfung anzeigen',{exact:true}).click();
  await page.locator('.review-layout').evaluate(node=>node.scrollIntoView({block:'start'}));
  await page.screenshot({path:join(assets,'entwurf.png')});
  await page.getByRole('button',{name:/Prüfen & freigeben/}).click();
  await capture('#review-dialog','freigabe');
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'Diese Fassung freigeben'}).click();
  await page.getByRole('button',{name:/Freigegebene Bewerbung absenden/}).click();
  await page.getByText('Der Eingang wurde vom Portal bestätigt.',{exact:true}).waitFor();
  await capture('.review-panel .notice.success','quittung');
} finally {
  await browser.close();
  for(const {server,runtime} of instances) {
    await new Promise(resolve=>server.close(resolve));
    runtime.store.close();
  }
  await rm(work,{recursive:true,force:true});
}
