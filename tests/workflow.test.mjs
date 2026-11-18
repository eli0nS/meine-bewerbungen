import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp,rm,mkdir,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { findJobMatches, matchListings, parseJobLink } from '../server/search.mjs';
import { makePdf } from '../server/documents.mjs';
import { assertDraftEvidence, generateDraft } from '../server/agent.mjs';

const exampleDraft={
  fit:'Baut Testsysteme.',gaps:'Keine weiteren Belege.',suitable:true,
  letter:'Ich baue Testsysteme. Diese praktische Erfahrung möchte ich bei der Entwicklung in Ihrem Team einbringen.',
  evidence:[{claim:'Ich baue Testsysteme.',requirement:'Entwicklung',support:{source:'cv',quote:'Mira Beispiel baut Testsysteme.'}}],
  values:[]
};

async function setup(scenario='success',mode='demo') {
  const dir=await mkdtemp(join(tmpdir(),'atelier-test-'));
  const runtime=createApp({dataDir:mode==='live'?join(dir,'live'):dir,mode,headless:true,fixtureScenario:scenario});
  const server=createServer(runtime.app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;runtime.setBase(base);
  const home=await fetch(base);const cookie=home.headers.get('set-cookie').split(';')[0];
  const state=await (await fetch(`${base}/api/state`,{headers:{cookie}})).json();
  const request=async(path,body={},method='POST')=>{
    const response=await fetch(base+'/api'+path,{method,headers:{cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:method==='GET'?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const prepared=async()=>{
    assert.equal((await request('/demo/seed')).status,200);
    assert.equal((await request('/template',{text:'Konkrete Erfahrungen früh nennen. Präziser Ton. Gespräch anbieten.'})).status,200);
    const result=await request('/prepare',{source:{board:'fixture',jobId:'demo',region:'local'}});
    assert.equal(result.status,200,JSON.stringify(result.body));return result.body.id;
  };
  const approve=async id=>{const r=await request(`/jobs/${id}/review`,{},'GET');return request(`/jobs/${id}/approve`,{hash:r.body.hash,revision:r.body.revision,acknowledged:true});};
  const close=async()=>{await new Promise(resolve=>server.close(resolve));runtime.store.close();await rm(dir,{recursive:true,force:true});};
  return {base,runtime,request,prepared,approve,close,dir};
}

async function saveSearchProfile(env) {
  const {profile}=env.runtime.store.read();
  const cvId=env.runtime.store.documents().find(d=>d.kind==='cv').id;
  const preferences={start:'',notice:profile.notice||'',salary:'',minimum:'',hours:'',place:'',workplace:''};
  const result=await env.request('/search-profile',{name:profile.name,email:profile.email,cvId,preferences});
  assert.equal(result.status,200,JSON.stringify(result.body));
}

function nativeCommand(env,args,input='') {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['tools/native-draft.mjs',...args],{env:{...process.env,ATELIER_DATA_DIR:env.dir},stdio:['pipe','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8').on('data',part=>{stdout+=part;});
    child.stderr.setEncoding('utf8').on('data',part=>{stderr+=part;});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve(stdout):reject(new Error(stderr)));
    child.stdin.end(input);
  });
}

test('Approval gate, immutable revisions, exact files, portal receipt and duplicate lock',async()=>{
  const env=await setup();
  try{
    const id=await env.prepared();
    assert.equal((await env.request(`/jobs/${id}/send`)).status,409);
    assert.equal(env.runtime.fixtures.size,0,'No portal is visited before approval');
    assert.equal((await env.approve(id)).status,200);
    let job=env.runtime.store.read().jobs[0];
    const stale=await env.request(`/jobs/${id}/review`,{},'GET');
    assert.equal((await env.request(`/jobs/${id}/letter`,{revision:job.revision,letter:job.letter+'\nIch freue mich auf das Gespräch.'})).status,200);
    assert.equal((await env.request(`/jobs/${id}/send`)).status,409);
    assert.equal((await env.request(`/jobs/${id}/approve`,{hash:stale.body.hash,revision:stale.body.revision,acknowledged:true})).status,409);
    assert.equal((await env.approve(id)).status,200);
    const result=await env.request(`/jobs/${id}/send`);
    assert.equal(result.body.status,'sent',JSON.stringify(result.body));
    job=env.runtime.store.read().jobs[0];assert.equal(job.status,'sent');assert.ok(job.confirmation.url.includes('/confirmation?receipt='));
    assert.equal(env.runtime.fixtures.get(id).received,1);
    assert.equal((await env.request(`/jobs/${id}/send`)).status,409);
    assert.equal((await env.approve(id)).status,409);
  }finally{await env.close();}
});

for(const scenario of ['captcha','login','required','unclear'])test(`Portal ${scenario} is stopped with accurate outcome`,async()=>{
  const env=await setup(scenario);
  try{
    const id=await env.prepared();await env.approve(id);
    const result=await env.request(`/jobs/${id}/send`);
    assert.equal(result.body.status,scenario==='unclear'?'unknown':'blocked',JSON.stringify(result.body));
    assert.equal(env.runtime.fixtures.get(id).received,scenario==='unclear'?1:0);
    assert.equal((await env.request(`/jobs/${id}/send`)).status,409);
    if(scenario==='unclear')assert.equal((await env.approve(id)).status,409);
  }finally{await env.close();}
});

test('Missing answers, changed answers, foreign targets and request origins fail closed',async()=>{
  const env=await setup();
  try{
    const id=await env.prepared();await env.approve(id);
    const job=env.runtime.store.read().jobs[0];
    const edit={revision:job.revision,employer:job.employer,title:job.title,target:job.target,letter:job.letter,answers:job.answers.map(a=>({...a,value:a.key==='email'?'':a.value})),attachments:job.attachments};
    assert.equal((await env.request(`/jobs/${id}`,{...edit,target:'https://example.com/submit'},'PUT')).status,400);
    assert.equal((await env.request(`/jobs/${id}`,edit,'PUT')).status,200);
    assert.equal((await env.approve(id)).status,400);
    assert.equal((await env.request(`/jobs/${id}/send`)).status,409);
    const response=await fetch(env.base+'/api/demo/seed',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{}'});
    assert.ok([401,403].includes(response.status));assert.equal(env.runtime.fixtures.size,0);
  }finally{await env.close();}
});

test('Restart converts interrupted sends to unknown and never replays them',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'atelier-recovery-'));
  try{
    let store=new Store(join(dir,'state.sqlite'));const state=store.read();state.jobs=[{id:'recovery',status:'sending'}];store.save(state);store.close();
    store=new Store(join(dir,'state.sqlite'));assert.equal(store.read().jobs[0].status,'unknown');store.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Actual dashboard walkthrough, screenshots and responsive accessibility',async()=>{
  const env=await setup();const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(env.base);
    await page.getByRole('button',{name:/Mit Beispieldaten ausprobieren/}).click();
    await page.getByRole('button',{name:'Unterlagen',exact:true}).click();
    await page.getByRole('heading',{name:'Lebenslauf',exact:true}).waitFor();
    await page.getByRole('button',{name:'Schreibvorlage',exact:true}).click();
    await page.getByText('Vorlage im Beispielmodus bearbeiten',{exact:true}).click();
    await page.getByRole('button',{name:/Vorlage aus meinen Antworten erstellen/}).click();
    await page.getByRole('button',{name:/^Bewerbungen/}).first().click();
    await page.getByRole('button',{name:/Beispielstelle suchen/}).click();
    await page.getByRole('button',{name:/Bewerbung vorbereiten/}).click();
    await page.getByRole('button',{name:/Prüfen & freigeben/}).waitFor();
    await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/dashboard-desktop.png',fullPage:true});
    const violations=(await new AxeBuilder({page}).analyze()).violations.filter(v=>v.impact==='critical'||v.impact==='serious');
    assert.deepEqual(violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
    for(const width of [320,768,1024,1440]){
      await page.setViewportSize({width,height:1000});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Horizontal overflow at ${width}`);
      if(width===320)await page.screenshot({path:'test-results/dashboard-mobile.png',fullPage:true});
    }
    await page.getByRole('button',{name:/Prüfen & freigeben/}).click();await page.getByRole('checkbox').check();
    await page.getByRole('button',{name:'Diese Fassung freigeben',exact:true}).click();
    await page.getByRole('button',{name:/Freigegebene Bewerbung absenden/}).click();
    await page.getByText('Der Eingang wurde vom Portal bestätigt.',{exact:true}).waitFor({timeout:45000});
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'test-results/dashboard-confirmed.png',fullPage:true});assert.deepEqual(errors,[]);
    const downloading=page.waitForEvent('download');
    await page.getByRole('button',{name:'Übersicht als HTML speichern'}).click();
    const archive=await downloading;
    assert.equal(archive.suggestedFilename(),'Meine-Bewerbungen.html');
    const path=join(await mkdtemp(join(tmpdir(),'bewerbungen-html-')),'Meine Bewerbungen.html');
    try {
      await archive.saveAs(path);
      assert.doesNotMatch(await readFile(path,'utf8'),/mira\.beispiel@example\.invalid|<script|api\/documents/);
      await context.setOffline(true);
      await page.goto(pathToFileURL(path).href);
      await page.getByRole('cell',{name:'Bestätigt versandt'}).waitFor();
    } finally { await rm(new URL('.',pathToFileURL(path)),{recursive:true,force:true}); }
  }finally{await browser.close();await env.close();}
});

test('Job links accept only direct Greenhouse listings and never fetch other hosts',async()=>{
  assert.deepEqual(parseJobLink('https://boards.greenhouse.io/acme/jobs/123?gh_src=abc#app'),{board:'acme',jobId:'123',region:'global'});
  assert.deepEqual(parseJobLink('https://job-boards.eu.greenhouse.io/acme/jobs/123'),{board:'acme',jobId:'123',region:'eu'});
  for(const link of ['https://job-boards.greenhouse.io.attacker.invalid/acme/jobs/123','https://job-boards.greenhouse.io:777/acme/jobs/123','https://example.invalid/role','http://boards.greenhouse.io/acme/jobs/123','https://job-boards.greenhouse.io/acme/jobs/abc']) assert.throws(()=>parseJobLink(link),/direkten Link/);
  const env=await setup('success','live');
  try {
    const result=await env.request('/search',{url:'https://example.invalid/role'});
    assert.equal(result.status,400);
    assert.match(result.body.error,/Lebenslauf/);
    assert.equal((await env.request('/search',{})).status,400);
    assert.equal((await env.request('/research',{})).status,400);
    assert.equal((await env.request('/prepare',{source:{board:'acme',jobId:'123',region:'global',employer:'Acme'}})).status,400);
    assert.equal((await env.request('/demo/seed')).status,400);
  } finally {await env.close();}
});

test('Provider setup distinguishes missing, signed out, ready and manual handoff without an account',async()=>{
  const old=process.env.ATELIER_CODEX_COMMAND;
  const dir=await mkdtemp(join(tmpdir(),'provider test '));
  const env=await setup('success','live');
  try {
    const fake=join(dir,'provider.mjs');
    process.env.ATELIER_CODEX_COMMAND=fake;
    assert.equal((await env.request('/providers/codex',{},'GET')).body.status,'missing');
    assert.equal((await env.request('/providers/codex/login')).status,400);
    await writeFile(fake,'process.exit(1)');
    assert.equal((await env.request('/providers/codex',{},'GET')).body.status,'signed_out');
    await writeFile(fake,'console.log("Logged in using ChatGPT")');
    assert.equal((await env.request('/providers/codex',{},'GET')).body.status,'ready');
    assert.equal((await env.request('/providers/claude',{},'GET')).body.status,'manual');
    assert.equal((await env.request('/providers/claude/login')).status,404);
  } finally {
    if(old===undefined) delete process.env.ATELIER_CODEX_COMMAND; else process.env.ATELIER_CODEX_COMMAND=old;
    await env.close();await rm(dir,{recursive:true,force:true});
  }
});

test('Native Claude Code handoff searches, checks the PDF, imports a verified draft and preserves approval',async()=>{
  const env=await setup('success','live');
  const browser=await chromium.launch({headless:true});
  const localFetch=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async (input,options)=>{
    const url=new URL(input);
    if(url.origin===env.base) return localFetch(input,options);
    requests.push([url.href,options?.method||'GET']);
    if(url.href==='https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true') return Response.json({jobs:[
      {id:123,title:'Test Engineer',location:{name:'Munich, Germany'},content:'Entwicklung und Messreihen. Validierung von Testsystemen und Sensorik.'},
      {id:125,title:'Test Engineer',location:{name:'Berlin'},content:'Versuche, Messreihen und Testsysteme.'},
      {id:126,title:'Marketing Lead',location:{name:'Munich, Germany'},content:'Kampagnen und Marketingstrategie.'}
    ]});
    if(url.href==='https://boards-api.greenhouse.io/v1/boards/fixture') return Response.json({name:'Nordstern Test'});
    if(url.href==='https://boards-api.greenhouse.io/v1/boards/fixture/jobs/123?questions=true') return Response.json({
      title:'Test Engineer',location:{name:'Beispielstadt'},content:'Entwicklung und Messreihen',
      questions:[
        {label:'E-Mail',required:true,fields:[{name:'email',type:'input_text'}]},
        {label:'Anschreiben',required:true,fields:[{name:'cover_letter',type:'input_file'}]}
      ]
    });
    throw new Error('Unexpected external request');
  };
  try {
    await env.request('/provider',{provider:'claude'});
    await env.request('/profile',{name:'Mira Beispiel',email:'nur-lokal@example.invalid',phone:'+49 000',city:'Beispielstadt',evidence:'Messreihen planen',criteria:'Vollzeit',notice:'Vier Wochen'});
    await env.request('/template',{text:'Alte Schreibhinweise'});
    for(const [kind,content] of [['cv','Mira Beispiel baut Testsysteme.'],['sample','Ich plane Messreihen und werte die Messdaten aus.']]) {
      const bytes=await makePdf('Fiktiver Text',content);
      assert.equal((await env.request('/documents',{kind,base64:bytes.toString('base64'),name:kind+'.pdf'})).status,200);
    }
    await saveSearchProfile(env);
    const matched=await env.request('/search',{query:'Testing',place:'München',boards:['https://job-boards.greenhouse.io/fixture']});
    assert.equal(matched.status,200,JSON.stringify(matched.body));
    assert.deepEqual(matched.body.listings.map(job=>job.source.jobId),['123']);
    assert.ok(matched.body.listings[0].matchesProfile.includes('testsysteme'));
    const listing=(await env.request('/search',{url:'https://job-boards.greenhouse.io/fixture/jobs/123'})).body.listings[0];
    assert.equal(listing.employer,'Nordstern Test');
    assert.equal((await env.request('/claude/export',{source:listing.source})).status,400);
    const exported=await env.request('/claude/export',{source:listing.source,consent:true});
    assert.equal(exported.status,200,JSON.stringify(exported.body));
    assert.match(exported.body.prompt,/Testsysteme/);
    assert.match(exported.body.prompt,/werte die Messdaten aus/);
    assert.doesNotMatch(exported.body.prompt,/nur-lokal@example\.invalid/);
    assert.doesNotMatch(exported.body.prompt,/Alte Schreibhinweise/);
    const draft=structuredClone(exampleDraft);
    const audit={accepted:true,summary:'Tätigkeiten sind belegt.',issues:[]};
    const badDraft=structuredClone(draft);
    badDraft.evidence[0].support.quote='Ich plane Messreihen und werte die Messdaten aus.';
    const rejected=await env.request('/prepare',{source:listing.source,consent:true,draft:badDraft,audit});
    assert.equal(rejected.status,400);
    assert.match(rejected.body.error,/Belegstelle fehlt/);
    assert.equal(env.runtime.store.read().jobs.length,0);
    const page=await browser.newPage();
    await page.goto(env.base);
    await page.getByRole('navigation').getByRole('button',{name:'Bewerbungen',exact:true}).click();
    await page.getByLabel('Ort oder Remote (optional)').fill('München');
    await page.getByLabel('Rolle oder Stichwörter (optional)').fill('Testing');
    await page.getByText('Weitere Firmenportale einbeziehen',{exact:true}).click();
    await page.getByLabel('Greenhouse-Firmenlinks').fill('https://job-boards.greenhouse.io/fixture');
    await page.getByRole('button',{name:/Stellen nach Lebenslauf suchen/}).click();
    await page.getByRole('button',{name:/Bewerbung vorbereiten/}).click();
    await page.getByRole('checkbox').check();
    await page.getByRole('button',{name:/Auftrag für Claude Code erstellen/}).click();
    await page.getByText('Warte auf Claude Code …',{exact:true}).waitFor();
    const [{id}]=JSON.parse(await nativeCommand(env,['list']));
    assert.equal((await env.request(`/native/${id}`,{},'GET')).body.status,'waiting');
    const packet=JSON.parse(await nativeCommand(env,['read',id]));
    assert.match(packet.context.cvText,/Testsysteme/);
    assert.ok(packet.schema.properties.audit);
    await assert.rejects(nativeCommand(env,['read','../atelier.sqlite']));
    await nativeCommand(env,['complete',id],JSON.stringify({draft,audit}));
    await page.getByRole('button',{name:/Prüfen & freigeben/}).waitFor();
    const [job]=env.runtime.store.read().jobs;
    assert.equal(job.status,'prepared');
    assert.equal(job.audit.method,'Claude Code');
    assert.equal((await env.request(`/jobs/${job.id}/send`)).status,409);
    assert.deepEqual(JSON.parse(await nativeCommand(env,['list'])),[]);
    assert.equal(job.answers[0].value,'nur-lokal@example.invalid');
    assert.equal(job.attachments.length,2);
    assert.ok(requests.length>0&&requests.every(([url,method])=>method==='GET'||(method==='POST'&&url==='https://ag.wd3.myworkdayjobs.com/wday/cxs/ag/Airbus/jobs')));
    assert.ok(requests.every(([url])=>!url.includes('Mira')&&!url.includes('Bewerbungsprofil')));
    const again=await env.request('/search',{query:'Testing',place:'München',boards:['https://job-boards.greenhouse.io/fixture']});
    assert.deepEqual(again.body.listings,[]);
  } finally {globalThis.fetch=localFetch;await browser.close();await env.close();}
});

test('Codex writes and verifies the letter in separate local client calls',async()=>{
  const old=process.env.ATELIER_CODEX_COMMAND;
  const dir=await mkdtemp(join(tmpdir(),'codex roles '));
  try {
    const cli=join(dir,'model.mjs');
    const log=join(dir,'calls.log');
    await writeFile(cli,`import {writeFile,appendFile} from 'node:fs/promises';
      const args=process.argv.slice(2);
      if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
      const chunks=[];for await(const chunk of process.stdin) chunks.push(chunk);
      const input=Buffer.concat(chunks).toString();
      const reviewer=input.startsWith('ROLLE: Lebenslauf-Faktenprüfung');
      if(args[args.indexOf('--model')+1]!=='gpt-6.2-sol'||!args.includes('model_reasoning_effort="medium"'))process.exit(4);
      if(!args.includes('shell_tool')||!args.includes('mcp_servers={}'))process.exit(3);
      await appendFile(${JSON.stringify(log)},reviewer?'audit\\n':'draft\\n');
      const data=reviewer?{accepted:true,summary:'Belegt.',issues:[]}:${JSON.stringify(exampleDraft)};
      await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(data));`);
    process.env.ATELIER_CODEX_COMMAND=cli;
    let reviewStarted=false;
    const result=await generateDraft({cvText:'Mira Beispiel baut Testsysteme.',listing:{description:'Entwicklung und Messreihen'}},()=>{reviewStarted=true;});
    assert.equal(reviewStarted,true);
    assert.equal(result.audit.accepted,true);
    assert.equal(await readFile(log,'utf8'),'draft\naudit\n');
  } finally {
    if(old===undefined) delete process.env.ATELIER_CODEX_COMMAND; else process.env.ATELIER_CODEX_COMMAND=old;
    await rm(dir,{recursive:true,force:true});
  }
});

test('Draft evidence must cite the actual advert and applicant sources',()=>{
  const context={cvText:'Mira Beispiel baut\nTestsysteme.',profile:{notice:'Vier Wochen'},listing:{description:'Entwicklung und Messreihen'},questions:[{key:'start',options:['Vier Wochen']}]};
  const draft={...structuredClone(exampleDraft),values:[{key:'start',value:'Vier Wochen',support:{source:'notice',quote:'Vier Wochen'}}]};
  assert.doesNotThrow(()=>assertDraftEvidence(context,draft));
  draft.evidence[0].requirement='Leitung eines Teams';
  assert.throws(()=>assertDraftEvidence(context,draft),/Stellenanzeige nicht belegt/);
  draft.evidence[0].requirement='Entwicklung';
  draft.values[0].value='Sofort';
  assert.throws(()=>assertDraftEvidence(context,draft),/Formularantwort/);
});

test('Sample upload is the default and keeps the alternative hidden while a PDF is active',async()=>{
  const env=await setup('success','live');
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    const page=await context.newPage();
    await page.goto(env.base+'/#schreibvorlage');
    const picker=page.getByLabel('Muster-PDF auswählen',{exact:true});
    await picker.waitFor({state:'attached'});
    assert.equal(await page.locator('#template-guide').isVisible(),false);
    await mkdir('test-results',{recursive:true});
    await page.screenshot({path:'test-results/template-desktop.png',fullPage:true});
    assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.filter(v=>['serious','critical'].includes(v.impact)),[]);
    await page.getByText('Ich habe kein Musteranschreiben',{exact:true}).click();
    assert.equal(await page.locator('#template-guide').isVisible(),true);
    await picker.setInputFiles({name:'ungueltig.pdf',mimeType:'application/pdf',buffer:Buffer.from('keine PDF')});
    await page.getByRole('alert').filter({hasText:'Bitte eine PDF-Datei'}).waitFor();
    const pdf=await makePdf('Fiktives Muster','Ich plane Versuche und werte Daten aus.');
    await picker.setInputFiles({name:'Beispiel-Muster.pdf',mimeType:'application/pdf',buffer:pdf});
    await page.getByText('Aktive Vorlage · PDF herunterladen',{exact:true}).waitFor();
    assert.equal(await page.locator('#template-guide').count(),0);
    const link=await page.getByRole('link',{name:/Beispiel-Muster.pdf/}).getAttribute('href');
    const pdfReply=await page.request.get(env.base+link);
    assert.match(pdfReply.headers()['content-disposition'],/^attachment/);
    assert.equal(pdfReply.headers()['x-frame-options'],'DENY');
    const crossSite=await page.request.get(env.base+link,{headers:{'Sec-Fetch-Site':'cross-site'}});
    assert.equal(crossSite.status(),403);
    await page.setViewportSize({width:320,height:780});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:'test-results/template-mobile.png',fullPage:true});
    await page.getByRole('button',{name:'Muster entfernen'}).click();
    await page.getByText('Ich habe kein Musteranschreiben',{exact:true}).waitFor();
    assert.equal(await page.locator('#template-guide').isVisible(),false);
    assert.equal((await page.request.get(env.base+link)).status(),404);
  }finally{await browser.close();await env.close();}
});

test('Research opens only after CV upload and accepts only matches for that same CV',async()=>{
  const env=await setup('success','live');
  try {
    await assert.rejects(findJobMatches({cvText:'',query:'Marketing'}),/Lebenslauf/);
    const cv='Mira Beispiel baut Testsysteme.';
    const hit={title:'Test Engineer',description:'Entwicklung und Validierung von Testsystemen für unterschiedliche Prüfstände.',location:'Beispielstadt',portal:'Firmenwebsite',employer:'Fiktives Labor',target:'https://example.org/jobs/test-engineer'};
    const miss={...hit,title:'Marketing Lead',description:'Kampagnenleitung für eine Marketingabteilung eines großen Unternehmens.',target:'https://example.org/jobs/marketing'};
    assert.deepEqual(matchListings([miss],{cvText:cv,query:'Marketing',evidence:'Marketing Lead'}),[]);
    assert.equal((await env.request('/research',{})).status,400);
    const addCv=async content=>env.request('/documents',{kind:'cv',base64:(await makePdf('Fiktiv',content)).toString('base64'),name:'beispiel.pdf'});
    await addCv(cv);
    assert.equal((await env.request('/research',{})).status,400);
    await saveSearchProfile(env);
    const {id}= (await env.request('/research',{place:'Beispielstadt'})).body;
    const packet=JSON.parse(await nativeCommand(env,['research','read',id]));
    assert.deepEqual(packet.topics,['Prüftechnik']);
    assert.doesNotMatch(JSON.stringify(packet),/Mira|Lebenslauf|@/);
    await assert.rejects(nativeCommand(env,['research','complete',id],JSON.stringify([{...hit,target:'http://127.0.0.1/private'}])));
    await nativeCommand(env,['research','complete',id],JSON.stringify([hit,miss]));
    const result=await env.request('/research/'+id,{},'GET');
    assert.deepEqual(result.body.listings.map(j=>j.target),[hit.target]);
    const {source}=result.body.listings[0];
    await env.request('/profile',{name:'Mira Beispiel',email:'mira@example.invalid',phone:'',city:'',evidence:'',criteria:'',notice:''});
    await env.request('/provider',{provider:'claude'});
    const draft=await env.request('/prepare',{source,consent:true,draft:exampleDraft,audit:{accepted:true,summary:'Belegt.',issues:[]}});
    assert.equal(draft.status,200,JSON.stringify(draft.body));
    assert.equal((await env.approve(draft.body.id)).status,400);
    assert.equal((await env.request('/jobs/'+draft.body.id+'/send')).status,409);
    await addCv('Fiktive Person mit ausschließlich Buchhaltung und Controlling.');
    assert.equal((await env.request('/research/'+id,{},'GET')).status,400);
  } finally {await env.close();}
});

test('Home accepts a dropped CV and opens the selected letter for review', async()=>{
  const env=await setup('success','live');
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:320,height:780}});
    await page.goto(env.base);
    const drop=page.locator('#cv-drop');
    await drop.waitFor();
    const pdf=await makePdf('Beispiel','Ich entwickle Prüfaufbauten.');
    await drop.evaluate((node,bytes)=>{
      const transfer=new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)],'Beispiel.pdf',{type:'application/pdf'}));
      node.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
    },Array.from(pdf));
    await page.getByRole('link',{name:/Beispiel.pdf/}).waitFor();

    await saveSearchProfile(env);
    const fixture=env.runtime.store.read();
    fixture.jobs=['Nord','West'].map(id=>({id,title:'Stelle '+id,employer:'Beispielfirma '+id,
      source:{region:'external'},target:'https://example.invalid/jobs/'+id,
      status:'prepared',location:'Beispielstadt',revision:1,letter:'Anschreiben für '+id,attachments:[],answers:[]}));
    env.runtime.store.save(fixture);
    await page.goto(env.base);
    await page.getByRole('button',{name:/Beispielfirma West/}).click();
    assert.equal(await page.locator('.reader-text').textContent(),'Anschreiben für West');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.getByRole('button',{name:'Bewerbung prüfen',exact:true}).click();
    assert.equal(await page.locator('#letter-text').inputValue(),'Anschreiben für West');
    await page.goto(env.base);
    await page.getByRole('button',{name:'Zur Stellensuche'}).click();
    await page.getByRole('button',{name:'Stellen nach Lebenslauf suchen'}).waitFor();
  } finally { await browser.close(); await env.close(); }
});

test('Hosted posting uses confirmed CV contacts and search profile before approval',async()=>{
  const env=await setup('success','live');
  const original=globalThis.fetch;
  const url='https://beispiel.jobs.personio.de/job/241';
  const record={'@type':'JobPosting',title:'Test Engineer',description:'Entwicklung und Messreihen für Testsysteme.',hiringOrganization:{name:'Testlabor'},jobLocation:{address:{addressLocality:'Beispielstadt'}}};
  globalThis.fetch=(link,options)=>{
    if(new URL(link).origin===env.base) return original(link,options);
    if(String(link)===url) return Promise.resolve(new Response('<script type="application/ld+json">'+JSON.stringify(record)+'</script>'));
    if(String(link)===url+'/apply') return Promise.resolve(new Response('<form><label>Vorname<input name="first_name"></label><label>Kündigungsfrist<input name="notice"></label><input type=file name="documents.cv"><input type=file name="documents.other"></form>'));
    throw new Error('Unerwartete Adresse im Test');
  };
  try {
    const pdf=await makePdf('Lebenslauf','Mira Beispiel\nmira.beispiel@example.invalid\nMira Beispiel baut Testsysteme.');
    const doc=await env.request('/documents',{kind:'cv',name:'beispiel.pdf',base64:pdf.toString('base64')});
    assert.equal((await env.request('/search',{url})).status,400);
    const state=(await env.request('/state',{},'GET')).body;
    assert.equal(state.contactSuggestions.name,'Mira Beispiel');
    assert.equal(state.contactSuggestions.email,'mira.beispiel@example.invalid');
    const profile={cvId:doc.body.id,name:state.contactSuggestions.name,email:'bestaetigt@example.invalid',
      preferences:{start:'2027-02-01',notice:'Sechs Wochen',salary:'70000',minimum:'61000',hours:'40',workplace:'Hybrid',place:''}};
    assert.equal((await env.request('/search-profile',profile)).status,200);
    await env.request('/provider',{provider:'claude'});
    const {listings}= (await env.request('/search',{url})).body;
    assert.equal(listings[0].applyTarget,url+'/apply');
    const create=await env.request('/prepare',{source:listings[0].source,consent:true,draft:exampleDraft,audit:{accepted:true,summary:'Belegt.',issues:[]}});
    assert.equal(create.status,200,JSON.stringify(create.body));
    const job=env.runtime.store.read().jobs[0];
    assert.equal(job.answers.find(a=>a.key==='email').value,profile.email);
    assert.equal(job.answers.find(a=>a.label==='Kündigungsfrist').value,'Sechs Wochen');
    assert.equal((await env.request('/jobs/'+job.id+'/send')).status,409);
    assert.equal((await env.approve(job.id)).status,200);
    profile.preferences.notice='Drei Monate';
    await env.request('/search-profile',profile);
    assert.equal((await env.request('/jobs/'+job.id+'/send')).status,409);
    assert.equal(env.runtime.store.read().jobs[0].answers.find(a=>a.label==='Kündigungsfrist').value,'Drei Monate');
  } finally {globalThis.fetch=original; await env.close();}
});
