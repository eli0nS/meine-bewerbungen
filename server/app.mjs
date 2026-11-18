import { preferencesSchema, extractContacts, preferenceAnswer, checkPreferences } from './search-profile.mjs';
import { hostedPortal, publicHostedListing } from './hosted-portals.mjs';
import express from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import Busboy from 'busboy';
import { Store, digest, now } from './store.mjs';
import { makePdf } from './documents.mjs';
import { seedDemo, demoLetter, demoListing, newJob } from './demo.mjs';
import { validateTarget, deliver, publicFormFields } from './portals.mjs';
import { findJobMatches, matchListings, officialListing, parseJobLink, searchTopics, sourceSchema } from './search.mjs';
import { assertDraftEvidence, auditSchema, draftPrompt, draftSchema, generateDraft, handoffSchema, installCodex, nativePacket, openCodexLogin, providerStatus } from './agent.mjs';
import { createNativeQueue } from './native-queue.mjs';
import { webResults } from './discovery.mjs';

const root = resolve(fileURLToPath(new URL('..',import.meta.url)));
const profileSchema = z.object({ name: z.string().max(160), email: z.string().max(200), phone: z.string().max(80), city: z.string().max(160), evidence: z.string().max(16000), criteria: z.string().max(2000), notice: z.string().max(200) }).strict();
const answerSchema = z.object({ key:z.string().regex(/^[a-zA-Z0-9_-]+$/), label:z.string().max(1000), type:z.string().max(80), required:z.boolean(), options:z.array(z.string().max(1000)).max(200), value:z.string().max(8000) }).strict();
const jobEdit = z.object({ revision:z.number().int(), employer:z.string().min(1).max(200), title:z.string().min(1).max(300), target:z.string().url(), letter:z.string().max(16000), answers:z.array(answerSchema).max(80), attachments:z.array(z.string().uuid()).max(10) }).strict();
const fail = (message,status=400) => Object.assign(new Error(message),{status});
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const jobSource=z.object({board:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),jobId:z.string().regex(/^[a-zA-Z0-9-]{1,40}$/),region:z.string(),employer:z.string().optional()});

async function pdfText(document,lines=false) {
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:new Uint8Array(document.bytes),useSystemFonts:true,isEvalSupported:false,enableXfa:false,stopAtErrors:true});
  try {
    const pdf=await task.promise;
    const pages=[];
    for(let n=1;n<=Math.min(pdf.numPages,12);n++) pages.push((await (await pdf.getPage(n)).getTextContent()).items.map(item=>(item.str||'')+(lines&&item.hasEOL?'\n':'')).join(' '));
    return pages.join('\n').trim().slice(0,24000);
  } catch { throw fail('Die PDF lässt sich nicht lesen. Wähle eine PDF mit auswählbarem Text und ohne Passwort.'); }
  finally { await task.destroy(); }
}

export function createApp({ dataDir, mode='demo', headless=mode==='demo', fixtureScenario='success', entry={} }) {
  const store = new Store(join(dataDir,'atelier.sqlite'));
  const app = express();
  const session = randomBytes(32).toString('hex');
  const cookieName = `bewerbung_${mode}`;
  const csrf = randomBytes(32).toString('hex');
  const fixtures = new Map();
  const native = createNativeQueue(join(dataDir,'native-inbox'));
  const research = createNativeQueue(join(dataDir,'research-inbox'));
  const discovered = new Map();
  let matchedTopics;
  function remember(listings) {
    for(const listing of listings) {
      if(listing.source) continue;
      const jobId=digest(listing.target).slice(0,32);
      const portal=hostedPortal(listing.target);
      listing.source={region:portal?'hosted':'external',board:'public',jobId};
      if(portal) {
        listing.portal=portal.provider;
        listing.applyTarget=portal.apply;
      }
      discovered.set(jobId,listing);
    }
    while(discovered.size>200) discovered.delete(discovered.keys().next().value);
    return listings;
  }
  let base = '';
  let preparing = false;
  let preparationStage='';
  app.disable('x-powered-by');
  app.use((req,res,next) => {
    if (base && req.headers.host !== new URL(base).host) return res.status(403).send('Lokaler Zugriff erforderlich.');
    res.set({ 'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY', 'Referrer-Policy':'no-referrer', 'Cache-Control':'no-store', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
    if ((req.method==='GET'&&req.path==='/health')||req.path.startsWith('/test-portal/')) return next();
    const cookie = req.headers.cookie?.split(';').some(v=>v.trim()===`${cookieName}=${session}`);
    if (req.method==='GET' && !req.path.startsWith('/api/')) res.cookie(cookieName,session,{httpOnly:true,sameSite:'strict',path:'/'});
    if (req.path.startsWith('/api/') && /^(cross-site|same-site)$/.test(req.headers['sec-fetch-site']||'')) return res.status(403).json({error:'Öffne diese Funktion direkt in der lokalen App.'});
    if (req.path.startsWith('/api/') && !cookie) return res.status(401).json({error:'Öffne zuerst die lokale Oberfläche.'});
    if (req.method!=='GET' && (!cookie || req.headers.origin!==base || req.headers['x-csrf-token']!==csrf)) return res.status(403).json({error:'Diese Aktion benötigt die lokale Oberfläche.'});
    next();
  });
  app.use(express.json({ limit:'12mb' }));
  const getJob = (state,id) => { const job=state.jobs.find(j=>j.id===id); if(!job) throw fail('Bewerbung nicht gefunden.',404); return job; };
  const editable = state => { if(state.jobs.some(j=>j.status==='sending')) throw fail('Bitte den laufenden Versand abwarten.',409); };
  const requiredMissing = job => job.answers.filter(a=>a.required&&!a.value.trim()).map(a=>a.label);

  async function liveContext(source,start,cv,sample) {
    let listing,details;
    if(['external','hosted'].includes(source.region)) {
      listing=discovered.get(source.jobId);
      if(!listing||listing.source.region!==source.region) throw fail('Bitte suche die Anzeige erneut, um ihren Entwurf vorzubereiten.');
      details={fields:listing.applyTarget?await publicFormFields(hostedPortal(listing.target)):[],hasCoverLetter:true};
    } else {
      const parsed=sourceSchema.parse(source);
      if(!/^\d{1,20}$/.test(source.jobId)) throw fail('Der Stellenlink ist ungültig.');
      ({listing,details}=await officialListing({...parsed,jobId:source.jobId}));
    }
    if(!details.hasCoverLetter) throw fail('Dieses Formular hat kein eigenes Feld fürs Anschreiben. Öffne den Stellenlink und prüfe, wie die Firma Bewerbungen entgegennimmt.');
    const [cvText,sampleText]=await Promise.all([pdfText(store.document(cv.id)),sample?pdfText(store.document(sample.id)):'']);
    if(!cvText) throw fail('Aus dem Lebenslauf konnte kein Text gelesen werden. Nutze eine PDF mit auswählbarem Text.');
    if(!matchListings([listing],{cvText}).length) throw fail('Für diese Stelle fehlt ein fachlicher Bezug im aktuellen Lebenslauf.');
    if(sample&&!sampleText) throw fail('Das Muster enthält keinen lesbaren Text. Wähle eine PDF mit auswählbarem Text.');
    const {name,evidence,criteria,notice}=start.profile;
    const context={profile:{name,evidence,criteria,notice},cvText,sampleText,template:sample?'':start.template,listing,questions:details.fields.filter(a=>a.type!=='checkbox'&&!['first_name','last_name','email','phone'].includes(a.key))};
    return {listing,details,context};
  }
  const newestDocument=kind=>store.documents().find(doc=>doc.kind===kind);
  function inputs(start) {
    const cv=newestDocument('cv');
    if(!cv) throw fail('Bitte zuerst den Lebenslauf hinterlegen.');
    const sample=newestDocument('sample');
    if(!start.profile.name || (mode==='live' && !start.profile.email)) throw fail('Bitte zuerst Namen und E-Mail im Profil hinterlegen.');
    return {cv,sample,hash:digest({profile:start.profile,preferences:start.preferences,template:start.template,provider:start.provider,cv:cv.hash,sample:sample?.hash})};
  }
  let activeLoginUntil=0;
  let installation;
  app.get('/health',(req,res)=>res.json({app:'meine-bewerbungen',mode,ready:true}));
  let extracted;
  const savedPreferences=cv=>{
    const prefs=store.read().preferences;
    if(!cv||!prefs||prefs.cvId!==cv.id) throw fail('Bitte bestätige zuerst die Angaben im Suchprofil.');
    return prefs;
  };
  app.get('/api/state',async(req,res)=>{
    const cv=newestDocument('cv');
    if(mode==='live'&&cv&&extracted?.id!==cv.id) {
      const contacts=extractContacts(await pdfText(store.document(cv.id),true).catch(()=>''));
      extracted={id:cv.id,...contacts};
    }
    res.json({...store.read(),documents:store.documents(),contactSuggestions:cv?.id===extracted?.id?extracted:null,
      mode,csrf,preparing,preparationStage,nativePending:native.pending(),entry});
  });
  app.post('/api/search-profile',async(req,res)=>{
    const input=z.object({cvId:z.string().uuid(),name:z.string().trim().max(160),email:z.union([z.literal(''),z.string().email().max(200)]),preferences:preferencesSchema}).strict().parse(req.body);
    const cv=newestDocument('cv');
    if(mode!=='live'||cv?.id!==input.cvId) throw fail('Der Lebenslauf hat sich geändert. Öffne das Suchprofil erneut.',409);
    if(input.preferences.occupation) {
      const normalized=s=>s.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
      if(!normalized(await pdfText(store.document(cv.id))).includes(normalized(input.preferences.occupation)))
        throw fail('Übernimm die Berufsbezeichnung genau aus deinem Lebenslauf oder lass sie offen.');
      if(newestDocument('cv')?.id!==cv.id) throw fail('Der Lebenslauf wurde geändert.',409);
    }
    const state=store.read();editable(state);
    const old=state.preferences||{};
    const preferences={...input.preferences,cvId:cv.id};
    const changed=JSON.stringify(old)!==JSON.stringify(preferences)||state.profile.name!==input.name||state.profile.email!==input.email;
    if(changed) for(const job of state.jobs.filter(j=>!['sent','unknown'].includes(j.status))) {
      store.invalidate(state,job,'Suchprofil geändert. Prüfe die Antworten und Anlagen erneut.');
      for(const answer of job.answers) {
        const before=preferenceAnswer(answer,old),after=preferenceAnswer(answer,preferences);
        if(before!==undefined&&answer.value===before) answer.value=after??'';
        if(answer.key==='email'&&answer.value===state.profile.email) answer.value=input.email;
        if(['first_name','last_name'].includes(answer.key)&&state.profile.name!==input.name) {
          const parts=input.name.split(/\s+/);
          answer.value=answer.key==='first_name'?parts[0]:parts.slice(1).join(' ');
        }
      }
    }
    state.profile={...state.profile,name:input.name,email:input.email,notice:preferences.notice};
    state.preferences=preferences; store.save(state);res.json({ok:true});
  });
  app.get('/api/prepare/progress',(req,res)=>res.json({stage:preparationStage}));
  app.get('/api/providers/:provider',async(req,res)=>{
    if(mode!=='live'||!['codex','claude'].includes(req.params.provider)) throw fail('Diese Verbindung ist hier nicht verfügbar.',404);
    res.json(await providerStatus(req.params.provider));
  });
  app.post('/api/providers/codex/login',async(req,res)=>{
    if(mode!=='live') throw fail('Für die Demo ist keine Anmeldung erforderlich.');
    if(Date.now()>=activeLoginUntil) {
      await openCodexLogin();
      activeLoginUntil=Date.now()+15000;
    }
    res.json({status:'opened'});
  });
  app.post('/api/providers/codex/install',async(req,res)=>{
    if(mode!=='live') throw fail('Für die Demo ist kein KI-Dienst erforderlich.');
    installation??=installCodex().finally(()=>{installation=undefined;});
    await installation;
    res.json({status:'installed'});
  });
  app.post('/api/profile',(req,res) => {
    const profile=profileSchema.parse(req.body);
    if (mode==='demo' && profile.email && !profile.email.endsWith('@example.invalid')) throw fail('Bitte in der Demo ausschließlich fiktive @example.invalid-Adressen nutzen.');
    const state=store.read(); editable(state);
    state.profile=profile;
    if(state.preferences) state.preferences.notice=profile.notice;
    for(const job of state.jobs.filter(j=>!['sent','unknown'].includes(j.status))) store.invalidate(state,job,'Profil geändert. Erneute Prüfung erforderlich.');
    store.event(state,'','Profil lokal gespeichert.'); store.save(state); res.json({ok:true});
  });
  app.post('/api/template',(req,res) => {
    const {text}=z.object({text:z.string().max(16000)}).strict().parse(req.body);
    const state=store.read(); state.template=text; store.event(state,'','Schreibvorlage gespeichert. Bereits erstellte Entwürfe bleiben separat prüfbar.'); store.save(state); res.json({ok:true});
  });
  app.post('/api/documents',async(req,res) => {
    const {name,kind,base64}=z.object({name:z.string().min(1).max(160),kind:z.enum(['cv','sample']),base64:z.string().max(11500000)}).strict().parse(req.body);
    const bytes=Buffer.from(base64,'base64');
    if(bytes.length>8*1024*1024||!bytes.subarray(0,5).equals(Buffer.from('%PDF-'))) throw fail('Bitte eine PDF-Datei bis 8 MB wählen.');
    if(mode==='demo') throw fail('Wähle für eigene PDFs den Bereich Eigene Bewerbung vorbereiten.');
    if(kind==='sample'&&!(await pdfText({bytes}))) throw fail('Das Muster enthält keinen lesbaren Text. Wähle eine PDF mit auswählbarem Text.');
    const state=store.read(); editable(state);
    const doc=store.addDocument(name.replace(/[\\/\x00-\x1f]/g,'_'),kind,bytes);
    if(kind==='sample') store.removeOtherSamples(doc.id);
    if(kind==='cv') for(const job of state.jobs.filter(j=>!['sent','unknown'].includes(j.status))) {
      store.invalidate(state,job,'Lebenslauf ausgetauscht. Anlagen und Antworten erneut prüfen.');
      job.attachments=job.attachments.filter(id=>store.document(id)?.kind!=='cv').concat(doc.id);
    }
    store.event(state,'','Dokument lokal abgelegt.'); store.save(state); res.json({id:doc.id});
  });
  app.delete('/api/template/sample',(req,res)=>{
    if(mode!=='live') throw fail('Die Demo enthält kein hochgeladenes Muster.');
    const state=store.read(); editable(state);
    store.removeOtherSamples();
    store.event(state,'','Musteranschreiben entfernt.'); store.save(state); res.json({ok:true});
  });
  app.get('/api/documents/:id',(req,res) => {
    const doc=store.document(req.params.id); if(!doc) throw fail('Dokument nicht gefunden.',404);
    res.attachment(doc.name).type('pdf').send(Buffer.from(doc.bytes));
  });
  app.post('/api/demo/seed',async(req,res) => {
    if(mode!=='demo') throw fail('Nur in der Demo verfügbar.');
    const state=store.read(); editable(state);
    if(state.jobs.length) throw fail('Demodaten sind bereits geladen. Zum erneuten Test eine neue Demobewerbung vorbereiten.');
    if(!store.documents().some(d=>d.kind==='cv')) await seedDemo(store);
    res.json({ok:true});
  });
  app.get('/api/demo/cv',(req,res) => {
    if(mode!=='demo') throw fail('Nur in der Demo verfügbar.');
    const doc=store.documents().find(d=>d.kind==='cv'); if(!doc) throw fail('Bitte erst Demodaten laden.');
    res.redirect(`/api/documents/${doc.id}`);
  });
  app.post('/api/search',async(req,res) => {
    const {url,query,place,boards}=z.object({query:z.string().max(300).optional(),place:z.string().max(160).optional(),boards:z.array(z.string().max(2400)).max(5).optional(),url:z.string().max(2400).optional()}).strict().parse(req.body);
    const cv=newestDocument('cv');
    if(!cv) throw fail('Hinterlege zuerst deinen Lebenslauf unter Unterlagen.');
    if(mode==='demo') return res.json({listings:[{...demoListing,matchesProfile:['Prüfaufbauten','Sensorik','Messreihen'],source:{board:'fixture',jobId:'demo',region:'local'}}]});
    const prefs=savedPreferences(cv);
    const searchPlace=place===undefined?prefs.place:place;
    const {jobs}=store.read();
    const cvText=await pdfText(store.document(cv.id));
    if(!cvText) throw fail('Die Suche braucht einen Lebenslauf mit auswählbarem Text.');
    const existing=jobs.map(job=>job.target);
    if(url?.trim()) {
      const portal=hostedPortal(url.trim());
      const listing=portal?await publicHostedListing(url.trim(),portal):(await officialListing(parseJobLink(url.trim()))).listing;
      return res.json({listings:remember(checkPreferences(matchListings([listing],{cvText,existing}),prefs))});
    }
    const result=await findJobMatches({cvText,query,place:searchPlace,boards,existing,preferences:prefs});
    matchedTopics={cvHash:cv.hash,titles:result.listings.slice(0,3).map(j=>j.title)};
    res.json({...result,listings:remember(result.listings)});
  });
  app.post('/api/research',async(req,res)=>{
    if(mode!=='live') throw fail('Diese Suche steht im eigenen Arbeitsbereich zur Verfügung.');
    const {place,query}=z.object({place:z.string().max(160).default(''),query:z.string().max(300).default('')}).strict().parse(req.body);
    const cv=newestDocument('cv');
    if(!cv) throw fail('Hinterlege zuerst deinen Lebenslauf.');
    const prefs=savedPreferences(cv);
    const topics=searchTopics(await pdfText(store.document(cv.id)));
    if(prefs.occupation&&!topics.includes(prefs.occupation)) topics.unshift(prefs.occupation);
    if(!topics.length&&matchedTopics?.cvHash===cv.hash) topics.push(...matchedTopics.titles);
    if(!topics.length) throw fail('Ergänze unter Suchprofil bearbeiten eine Berufsbezeichnung aus deinem Lebenslauf für die Firmenrecherche.');
    const id=await research.issue({topics,place},{hash:digest([cv.hash,place,query,prefs]),target:'web',cvHash:cv.hash,place,query,prefsHash:digest(prefs)});
    res.json({id,topics});
  });
  app.get('/api/research/:id',async(req,res)=>{
    const task=research.get(req.params.id);
    const cv=newestDocument('cv');
    if(!cv||cv.hash!==task.cvHash) throw fail('Dein Lebenslauf wurde geändert. Starte die Suche erneut.');
    const prefs=savedPreferences(cv);
    if(task.prefsHash!==digest(prefs)) throw fail('Das Suchprofil wurde geändert. Starte die Suche erneut.');
    const result=await research.result(req.params.id);
    if(!result) return res.json({status:'waiting'});
    const candidates=webResults.parse(result);
    const cvText=await pdfText(store.document(cv.id));
    res.json({status:'ready',listings:remember(matchListings(checkPreferences(candidates,prefs),{cvText,query:task.query,place:task.place,existing:store.read().jobs.map(j=>j.target)}))});
  });
  app.post('/api/claude/export',async(req,res) => {
    if(mode!=='live') throw fail('Die Demo verwendet einen fiktiven Entwurf.');
    const {source}=z.object({source:jobSource,consent:z.literal(true)}).strict().parse(req.body);
    const start=store.read();
    const {cv,sample}=inputs(start);
    const {context}=await liveContext(source,start,cv,sample);
    res.json({prompt:await draftPrompt(context)});
  });
  app.post('/api/native',async(req,res)=>{
    if(mode!=='live') throw fail('Die Demo verwendet einen fiktiven Entwurf.');
    const {source}=z.object({source:jobSource,consent:z.literal(true)}).strict().parse(req.body);
    const start=store.read();
    if(start.provider!=='claude') throw fail('Wähle zuerst Claude Code als Anbieter.');
    const {cv,sample,hash}=inputs(start);
    const {listing,context}=await liveContext(source,start,cv,sample);
    if(store.read().jobs.some(job=>job.target===listing.target)) throw fail('Diese Stelle wurde bereits erfasst.',409);
    if(inputs(store.read()).hash!==hash) throw fail('Die Unterlagen wurden geändert. Starte die Vorbereitung erneut.',409);
    const id=await native.issue(await nativePacket(context),{source,hash,target:listing.target});
    res.json({id});
  });
  app.get('/api/native/:id',async(req,res)=>{
    if(mode!=='live') throw fail('Nur für eigene Bewerbungen verfügbar.');
    res.json({status:await native.result(req.params.id)?'ready':'waiting'});
  });
  app.post('/api/prepare',async(req,res) => {
    const {source,consent,draft:imported,audit:importedAudit,nativeId}=z.object({source:jobSource,consent:z.literal(true).optional(),draft:draftSchema.optional(),audit:auditSchema.optional(),nativeId:z.string().uuid().optional()}).strict().parse(req.body);
    if(preparing) throw fail('Eine Vorbereitung läuft bereits.',409);
    const start=store.read(); editable(start);
    if(mode==='live'&&!consent) throw fail('Bitte bestätige vorher, welche Angaben du für den Entwurf verwenden möchtest.');
    if(mode==='live'&&start.provider==='claude'&&!nativeId&&(!imported||!importedAudit)) throw fail('Für Claude werden Anschreiben und Faktenprüfung benötigt.');
    const {cv,sample,hash:inputHash}=inputs(start);
    preparing=true;
    preparationStage='Anschreiben wird erstellt';
    try {
      let job;
      if(mode==='demo') {
        job=newJob({...demoListing, source:{board:'fixture',jobId:randomUUID(),region:'local'}, letter:demoLetter(start.profile,start.template),audit:{revision:1,method:'Beispiel',summary:'Fiktiver Lebenslauf und Beispielanschreiben stimmen überein.'},answers:[
          {key:'first_name',label:'Vorname',type:'input_text',required:true,options:[],value:start.profile.name.split(' ')[0]},
          {key:'last_name',label:'Nachname',type:'input_text',required:true,options:[],value:start.profile.name.split(' ').slice(1).join(' ')},
          {key:'email',label:'E-Mail',type:'input_text',required:true,options:[],value:start.profile.email},
          {key:'notice',label:'Kündigungsfrist',type:'input_text',required:true,options:[],value:start.profile.notice},
          {key:'salary',label:'Gehaltswunsch brutto/Jahr',type:'input_text',required:true,options:[],value:'60.000 € bei 40 Wochenstunden'}
        ]});
        job.target=`${base}/test-portal/${job.id}`;
      } else {
        const {listing,details,context}=await liveContext(source,start,cv,sample);
        if(start.jobs.some(j=>j.target===listing.target||(listing.applyTarget&&j.applyTarget===listing.applyTarget))) throw fail('Diese Stelle wurde bereits erfasst.',409);
        let result;
        if(start.provider==='claude'&&nativeId) {
          const metadata=native.get(nativeId);
          if(metadata.hash!==inputHash||digest(metadata.source)!==digest(source)) throw fail('Der Auftrag gehört zu einer früheren Fassung. Starte ihn erneut.',409);
          const received=await native.result(nativeId);
          if(!received) throw fail('Claude Code hat den Entwurf noch nicht übergeben.',409);
          result=handoffSchema.parse(received);
        } else if(start.provider==='claude') result=handoffSchema.parse({draft:imported,audit:importedAudit});
        else result=await generateDraft(context,()=>{preparationStage='Faktenprüfung läuft';});
        const {draft,audit}=result;
        if(!draft.suitable) throw fail(`Fachliche Passung reicht nicht aus. ${draft.gaps}`);
        if(!audit?.accepted||audit.issues.length) throw fail(`Die Faktenprüfung hat den Entwurf angehalten. ${audit?.issues.join(' ')||audit?.summary||''}`);
        assertDraftEvidence(context,draft);
        const name=start.profile.name.trim().split(/\s+/);
        const profileAnswers=new Map([['first_name',name[0]],['last_name',name.slice(1).join(' ')],['email',start.profile.email],['phone',start.profile.phone]]);
        const candidates=new Map(draft.values.map(a=>[a.key,a.value]));
        const answers=details.fields.map(field=>{
          const value=profileAnswers.get(field.key)??preferenceAnswer(field,start.preferences)??candidates.get(field.key)??'';
          return {...field,value:field.options.length&&!field.options.includes(value)?'':value};
        });
        const method=start.provider==='codex'?'Codex':nativeId?'Claude Code':'Claude · manueller Import';
        job=newJob({...listing,letter:draft.letter,fit:draft.fit,gaps:draft.gaps,answers,audit:{revision:1,method,summary:audit.summary}});
      }
      const letterBytes=await makePdf(job.title,job.letter);
      const state=store.read(); editable(state);
      if(inputHash!==inputs(state).hash) throw fail('Unterlagen oder KI-Dienst wurden während der Vorbereitung geändert. Bitte neu starten.',409);
      if(mode!=='demo'&&state.jobs.some(j=>j.target===job.target||(job.applyTarget&&j.applyTarget===job.applyTarget))) throw fail('Diese Stelle wurde bereits erfasst.',409);
      const letter=store.addDocument(`Anschreiben_${job.id.slice(0,8)}.pdf`,'letter',letterBytes);
      job.attachments=[cv.id,letter.id];
      state.jobs.unshift(job);
      store.event(state,job.id,'Anschreiben aus dem Lebenslauf erstellt und die Anlagen zugeordnet.');
      store.event(state,job.id,`Faktenprüfung abgeschlossen (${job.audit.method}). Die persönliche Prüfung steht aus.`);
      store.save(state);
      if(nativeId&&start.provider==='claude') await native.forget(nativeId).catch(()=>{});
      res.json({id:job.id});
    } finally { preparing=false;preparationStage=''; }
  });
  app.put('/api/jobs/:id',(req,res) => {
    const input=jobEdit.parse(req.body);
    const state=store.read(); const job=getJob(state,req.params.id);
    if(job.revision!==input.revision) throw fail('Diese Fassung ist veraltet. Bitte aktualisieren.',409);
    if(input.attachments.some(id=>!store.document(id))) throw fail('Eine Anlage ist nicht vorhanden.');
    // Portal keys and required flags are owned by the adapter, never by a client or model.
    if(JSON.stringify(input.answers.map(({value,...a})=>a))!==JSON.stringify(job.answers.map(({value,...a})=>a))) throw fail('Das Formularschema hat sich geändert. Bitte neu vorbereiten.');
    const previous=job.letter;
    store.invalidate(state,job,'Entwurf geändert. Bisherige Freigabe aufgehoben.');
    Object.assign(job,{...input,revision:job.revision});
    validateTarget(job,mode,base);
    if(job.answers.some(a=>a.options.length&&a.value&&!a.options.includes(a.value))) throw fail('Eine Antwort entspricht keiner verfügbaren Auswahl.');
    if(previous!==job.letter) throw fail('Bitte den separaten Text-Editor speichern.',409);
    store.save(state); res.json({ok:true});
  });
  app.post('/api/jobs/:id/letter',async(req,res) => {
    const input=z.object({revision:z.number().int(),letter:z.string().min(20).max(16000)}).strict().parse(req.body);
    const state=store.read(); const job=getJob(state,req.params.id);
    if(job.revision!==input.revision) throw fail('Diese Fassung ist veraltet.',409);
    if(['sending','sent','unknown'].includes(job.status)) throw fail('Der Versandvorgang ist gesperrt.',409);
    const doc=store.addDocument(`Anschreiben_${job.id.slice(0,8)}.pdf`,'letter',await makePdf(job.title,input.letter));
    // Re-read after asynchronous PDF creation to prevent concurrent edits from being overwritten.
    const latest=store.read(); const current=getJob(latest,job.id);
    if(current.revision!==input.revision||['sending','sent','unknown'].includes(current.status)) throw fail('Diese Fassung wurde inzwischen verändert.',409);
    store.invalidate(latest,current,'Anschreiben und PDF geändert. Erneute Freigabe erforderlich.');
    current.letter=input.letter;
    current.attachments=current.attachments.filter(id=>store.document(id)?.kind!=='letter').concat(doc.id);
    store.save(latest); res.json({ok:true});
  });
  app.get('/api/jobs/:id/review',(req,res) => {
    const state=store.read(); const job=getJob(state,req.params.id);
    validateTarget(job,mode,base);
    res.json({hash:store.snapshot(job,state),revision:job.revision,missing:requiredMissing(job)});
  });
  app.post('/api/jobs/:id/approve',(req,res) => {
    const input=z.object({hash:z.string().length(64),revision:z.number().int(),acknowledged:z.literal(true)}).strict().parse(req.body);
    const state=store.read(); const job=getJob(state,req.params.id);
    if(!['prepared','blocked'].includes(job.status)) throw fail('Diese Bewerbung kann nicht freigegeben werden.',409);
    if(job.source.region==='external') throw fail('Für diese Anzeige steht nur der persönliche Versand zur Verfügung.');
    validateTarget(job,mode,base);
    if(requiredMissing(job).length) throw fail('Bitte zuerst alle Pflichtantworten ergänzen.');
    if(!job.attachments.some(id=>store.document(id)?.kind==='cv')||!job.attachments.some(id=>store.document(id)?.kind==='letter')) throw fail('Lebenslauf und Anschreiben sind erforderlich.');
    const hash=store.snapshot(job,state);
    if(job.revision!==input.revision||hash!==input.hash) throw fail('Inhalte wurden geändert. Bitte erneut prüfen.',409);
    job.approval={hash,revision:job.revision,time:now()}; job.status='approved'; job.blocker='';
    store.event(state,job.id,'Diese konkrete Fassung wurde in der lokalen Oberfläche ausdrücklich freigegeben.'); store.save(state); res.json({ok:true});
  });
  app.post('/api/jobs/:id/send',async(req,res) => {
    const state=store.read(); const job=getJob(state,req.params.id);
    if(job.status!=='approved'||!job.approval) throw fail('Vor dem Versand ist die ausdrückliche Freigabe dieser Fassung erforderlich.',409);
    validateTarget(job,mode,base);
    if(job.approval.hash!==store.snapshot(job,state)||job.approval.revision!==job.revision) throw fail('Die Freigabe gehört zu einer anderen Fassung.',409);
    editable(state);
    const copy=structuredClone(job);
    const documents=job.attachments.map(id=>store.document(id));
    job.status='sending'; job.approval=null; store.event(state,job.id,'Versand der freigegebenen Fassung gestartet.'); store.save(state);
    const fixtureToken=randomBytes(24).toString('hex');
    fixtures.set(job.id,{token:fixtureToken,received:0,receipt:null});
    let result;
    try { result=await deliver({job:copy,documents,mode,base,headless,fixtureToken,onLogin:async()=>{
      const next=store.read(); store.event(next,job.id,'Bitte im geöffneten Browser bei JOIN anmelden und zur freigegebenen Stelle zurückkehren.'); store.save(next);
    },onSubmit:async()=>{
      const next=store.read(); store.event(next,job.id,'Konkrete Absendeaktion im Portal ausgelöst.'); store.save(next);
    }}); } catch { result={status:'unknown',message:'Der Versand wurde unerwartet unterbrochen. Bitte den Eingang persönlich prüfen.'}; }
    const next=store.read(); const current=getJob(next,job.id);
    if(mode==='demo'&&result.status==='sent'&&!fixtures.get(job.id)?.receipt) { result.status='unknown';result.message='Die lokale Portalquittung fehlt.'; }
    if(result.status==='blocked' && result.fields?.length) {
      const merged=answerSchema.array().max(80).safeParse([...current.answers,...result.fields]);
      if(merged.success) {current.answers=merged.data.map(a=>({...a,value:a.value||preferenceAnswer(a,next.preferences)||''}));current.revision++;}
      else result.message='Die neuen Portalfragen überschreiten die unterstützten Formulargrenzen.';
    }
    current.status=result.status; current.blocker=result.status==='sent'?'':result.message; current.confirmation=result.status==='sent'?{message:result.message,url:result.confirmationUrl,time:now()}:null;
    store.event(next,job.id,result.status==='sent'?'Portal hat den Eingang bestätigt.':result.message); store.save(next); res.json({status:result.status});
  });
  app.post('/api/provider',(req,res) => {
    if(mode==='demo') throw fail('Die Demo läuft mit fiktiven Entwürfen.');
    const {provider}=z.object({provider:z.enum(['codex','claude'])}).strict().parse(req.body);
    const state=store.read();state.provider=provider;store.save(state);res.json({ok:true});
  });
  app.get('/test-portal/:id',(req,res) => {
    if(mode!=='demo') return res.status(404).end();
    const job=getJob(store.read(),req.params.id);
    if(fixtureScenario==='captcha') return res.send('<div data-test="captcha">CAPTCHA erforderlich</div>');
    if(fixtureScenario==='login') return res.send('<label>Anmeldung<input type="password"></label>');
    const fields=job.answers.map(a=>`<label>${escape(a.label)}<input name="${escape(a.key)}" ${a.required?'required':''}></label>`).join('');
    const extra=fixtureScenario==='required'?'<label>Neue Pflichtfrage<input required name="new_required"></label>':'';
    res.send(`<!doctype html><html lang="de"><head><title>Nordstern · Lokales Testportal</title><link rel="stylesheet" href="/portal.css"></head><body><main><p>Lokales Testportal · ausschließlich fiktive Daten</p><h1>${escape(demoListing.employer)}</h1><h2>${escape(job.title)}</h2><form method="post" enctype="multipart/form-data">${fields}${extra}<label>Lebenslauf<input name="resume" type="file" required></label><label>Anschreiben<input name="cover_letter" type="file" required></label><input type="hidden" name="delivery_token"><button type="submit">Bewerbung absenden</button></form></main></body></html>`);
  });
  app.post('/test-portal/:id',(req,res) => {
    if(mode!=='demo') return res.status(404).end();
    const fixture=fixtures.get(req.params.id);
    if(!fixture||fixture.receipt) return res.status(403).send('Dieser Vorgang hat keine gültige Freigabe.');
    let parser;
    try { parser=Busboy({headers:req.headers,limits:{fileSize:8*1024*1024,files:2,fields:20}}); } catch { return res.status(400).send('Dateiupload erforderlich.'); }
    const fields={}; const uploads={}; let invalid=false;
    parser.on('field',(name,value)=>{fields[name]=value;});
    parser.on('file',(name,stream)=>{
      const chunks=[];
      stream.on('data',chunk=>chunks.push(chunk));
      stream.on('limit',()=>{invalid=true;});
      stream.on('end',()=>{uploads[name]=digest(Buffer.concat(chunks));});
    });
    parser.on('error',()=>{if(!res.headersSent)res.status(400).send('Upload unvollständig.');});
    parser.on('close',()=>{
      if(res.headersSent) return;
      const job=getJob(store.read(),req.params.id);
      const expected=job.attachments.map(id=>store.document(id));
      if(invalid||job.status!=='sending'||fixture.receipt||fields.delivery_token!==fixture.token||expected.some(doc=>uploads[doc.kind==='cv'?'resume':'cover_letter']!==doc.hash)||job.answers.some(a=>fields[a.key]!==a.value)) return res.status(403).send('Unterlagen oder Antworten stimmen nicht mit der Freigabe überein.');
      fixture.received++;
      fixture.receipt=randomUUID();
      if(fixtureScenario==='unclear') return res.status(502).send('Der Vorgang konnte nicht eindeutig bestätigt werden.');
      res.redirect(303,`/test-portal/${req.params.id}/confirmation?receipt=${fixture.receipt}`);
    });
    req.pipe(parser);
  });
  app.get('/test-portal/:id/confirmation',(req,res) => {
    if(mode!=='demo') return res.status(404).end();
    const fixture=fixtures.get(req.params.id);
    const job=getJob(store.read(),req.params.id);
    const saved=job.status==='sent'&&job.confirmation?.url?new URL(job.confirmation.url).searchParams.get('receipt'):null;
    const receipt=job.status==='sending'?fixture?.receipt:saved;
    if(!receipt||req.query.receipt!==receipt) return res.status(404).end();
    res.send(`<!doctype html><html lang="de"><head><title>Portalbestätigung</title><link rel="stylesheet" href="/portal.css"></head><body><main><p>Lokales Testportal · fiktiver Eingang</p><h1>Ihre Bewerbung ist eingegangen.</h1><p>Nordstern Systeme bestätigt den Eingang für Entwicklungsingenieur:in Prüfsysteme.</p><p>Quittung ${escape(receipt)}</p></main></body></html>`);
  });
  app.use('/api',(req,res)=>res.status(404).json({error:'Diese Aktion ist hier nicht verfügbar.'}));
  app.use(express.static(join(root,'web'),{index:'index.html'}));
  app.use((error,req,res,next) => {
    if(res.headersSent) return next(error);
    res.status(error instanceof z.ZodError?400:error.status||400).json({error:error instanceof z.ZodError?'Bitte die eingegebenen Angaben prüfen.':error.message});
  });
  return { app,store,fixtures,setBase:url=>{base=url;} };
}
