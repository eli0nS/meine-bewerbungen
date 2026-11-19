import { createHash } from 'node:crypto';
import { inspectCheckboxes, checkboxReview } from './portal-checkboxes.mjs';

// Only official, job-specific hosted URLs can be promoted from a research result.
export function hostedPortal(raw) {
  let url;
  try { url=new URL(raw); } catch { return null; }
  if(url.protocol!=='https:'||url.port||url.username||url.password) return null;
  let path=url.pathname.replace(/\/$/,'');
  let provider;
  if(/^[a-z0-9-]+\.jobs\.personio\.(de|com)$/.test(url.hostname)&&/^\/job\/\d+(\/apply)?$/.test(path)) {
    provider='Personio'; path=path.replace(/\/apply$/,'');
  } else if(url.hostname==='join.com'&&/^\/(?:[a-z]{2}\/)?companies\/[a-z0-9-]+\/\d+(?:-[^/]+)?(?:\/apply(?:\/[a-zA-Z]+)?)?$/.test(path)) {
    provider='JOIN'; path=path.replace(/^\/[a-z]{2}\//,'/').replace(/(\/\d+)(?:-[^/]+)?(?:\/apply(?:\/[a-zA-Z]+)?)?$/,'$1');
  } else if(['jobs.lever.co','jobs.eu.lever.co'].includes(url.hostname)&&/^\/[\w-]+\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}(\/apply)?$/i.test(path)) {
    provider='Lever'; path=path.replace(/\/apply$/,'');
  } else if(/^[a-z0-9-]+\.teamtailor\.com$/.test(url.hostname)&&/^\/jobs\/\d+(?:-[\w%-]+)?(?:\/applications\/new)?$/.test(path)) {
    return {provider:'Teamtailor',apply:url.origin+path.replace(/\/applications\/new$/,'')+'/applications/new'};
  } else return null;
  return {provider,apply:url.origin+path+'/apply'};
}

export function contactFields() {
  return [['first_name','Vorname'],['last_name','Nachname'],['email','E-Mail'],['phone','Telefon']].map(([key,label])=>({
    key,label,type:'input_text',required:key!=='phone',options:[],value:''
  }));
}

function contactKey(el) {
  const text=(el.label||el.name).trim().replace(/\s*[*:]\s*$/,'').toLowerCase();
  if(/^(vorname|first[ _-]?name|given[ _-]?name)$/.test(text)) return 'first_name';
  if(/^(nachname|last[ _-]?name|family[ _-]?name|surname)$/.test(text)) return 'last_name';
  if(/^(name|full[ _-]?name|vollständiger name|vor- und nachname)$/.test(text)) return 'full_name';
  if(/^(email|e-mail)([ -]?(adresse|address))?$/.test(text)) return 'email';
  if(/^(telefon(nummer)?|phone( number)?|mobilnummer|mobile)$/.test(text)) return 'phone';
}

// Read only the controls of the active application step. Stable question keys bind
// the visible wording and choices to the answer approved in the local dashboard.
export async function hostedStep(page,job,documents,uploaded,inspectOnly=false,finalStep=false,address=page.url()) {
  const forms=page.locator('form').filter({has:page.locator('input[type=file],input[type=email],textarea,input[name=first_name]')});
  if(await forms.count()>1) return {status:'blocked',message:'Mehrere mögliche Bewerbungsformulare auf der Seite.'};
  const scope=await forms.count()===1?forms:page.locator('main').first();
  const controls=scope.locator('input:not([type=checkbox]),textarea,select');
  const fields=await controls.evaluateAll(nodes=>nodes.map((e,index)=>{
    if(e.disabled||e.getAttribute('aria-hidden')==='true'||['hidden','submit','button','reset','search'].includes(e.type)) return null;
    if(e.type!=='file'&&!e.getClientRects().length) return null;
    const label=(Array.from(e.labels||[]).map(l=>{const clone=l.cloneNode(true);clone.querySelectorAll('select,textarea,input').forEach(c=>c.remove());return clone.textContent;}).join(' ')||e.getAttribute('aria-label')||
      (e.getAttribute('aria-labelledby')||'').split(' ').map(id=>document.getElementById(id)?.innerText||'').join(' ').trim()||
      e.placeholder||'').trim().replace(/\s+/g,' ');
    const legend=e.closest('fieldset')?.querySelector(':scope > legend')?.innerText?.trim();
    return {index,label,legend,name:e.name||e.id,type:e.type,required:e.required||e.getAttribute('aria-required')==='true'||label.endsWith('*'),
      options:e.options?Array.from(e.options).filter(o=>o.value&&!o.disabled).map(o=>o.text.trim()):[],
      checked:e.checked,populated:Boolean(e.value),role:e.getAttribute('role')};
  }).filter(Boolean));
  const answers=new Map(job.answers.map(a=>[a.key,a]));
  const stop=message=>({status:'blocked',message});
  const checkboxes=await inspectCheckboxes(scope,job.answers,address,inspectOnly);
  if(checkboxes.message) return stop(checkboxes.message);
  const additions=[...checkboxes.fields],actions=[...checkboxes.actions],seen=new Set(),fileKinds=new Set();
  for(const el of fields) {
    const field=controls.nth(el.index);
    if(el.type==='file') {
      const hint=(el.label+' '+el.name).toLowerCase();
      const cv=/lebenslauf|résumé|resume|\bcv\b|[_-]cv\b/.test(hint);
      const letter=/anschreiben|bewerbungsschreiben|motivationsschreiben|cover[ _-]?letter/.test(hint);
      const extra=!fields.some(f=>f.type==='file'&&/cover[ _-]?letter|anschreiben|bewerbungsschreiben/i.test(f.label+' '+f.name))&&
        (el.name==='documents.other'||/^(additional documents|zusätzliche dokumente)$/i.test(el.label));
      if(cv===(letter||extra)) {
        if(el.required||el.populated) return stop('Das Portal verlangt eine nicht eindeutig zugeordnete Anlage.');
        continue;
      }
      const kind=cv?'cv':'letter';
      if(fileKinds.has(kind)) return stop('Mehrere Uploadfelder für dieselbe Anlage gefunden.');
      fileKinds.add(kind);
      if(inspectOnly) continue;
      const matches=documents.filter(d=>d.kind===kind);
      if(matches.length!==1) return stop('Die freigegebenen Anlagen sind nicht eindeutig.');
      const doc=matches[0];
      actions.push(async()=>{
        await field.setInputFiles({name:doc.name,mimeType:'application/pdf',buffer:Buffer.from(doc.bytes)});
        uploaded.add(kind);
      });
      continue;
    }
    if(el.type==='radio') {
      const choices=fields.filter(f=>f.type==='radio'&&f.name===el.name);
      if(choices[0]!==el) continue;
      const label=el.legend||el.name;
      const options=choices.map(f=>f.label);
      if(!label||options.some(o=>!o)||new Set(options).size!==options.length) return stop('Die Auswahlmöglichkeiten einer Portalfrage sind nicht eindeutig.');
      const required=choices.some(c=>c.required);
      const key='portal_'+createHash('sha256').update(JSON.stringify([el.name,label,options,required])).digest('hex').slice(0,24);
      const answer=answers.get(key);
      if(!answer) additions.push({key,label,type:'radio',options,required,value:''});
      else if(answer.value) {
        const choice=choices.find(c=>c.label===answer.value);
        if(!choice) return stop('Die Auswahlmöglichkeiten haben sich geändert.');
        actions.push(()=>controls.nth(choice.index).check());
      } else if(required||choices.some(c=>c.checked)) return stop('Bitte eine Antwort für '+label+' wählen.');
      continue;
    }
    if(el.type==='password'||el.role==='combobox'&&el.type!=='select-one') {
      if(el.required||el.populated||el.type==='password') return stop('Dieses Formular enthält eine Anmeldung oder eine nicht eindeutig zuordenbare Auswahl.');
      continue;
    }
    if(!['text','email','tel','url','number','textarea','select-one','date'].includes(el.type)) {
      if(el.required||el.populated) return stop('Ein Pflichtfeld benötigt eine persönliche Prüfung.');
      continue;
    }
    if(!el.label&&!el.name) {if(el.required||el.populated)return stop('Ein Feld ist nicht beschriftet.');continue;}
    const label=el.label||el.name;
    const options=el.options;
    if(label.length>1000||options.length>200||options.some(o=>o.length>1000)) return stop('Die Portalfrage ist zu umfangreich für die lokale Freigabe.');
    if(el.type==='textarea'&&/^(cover letter|anschreiben|bewerbungsschreiben)\s*\*?$/i.test(label)) {
      if(!inspectOnly) actions.push(()=>field.fill(job.letter));
      continue;
    }
    const contact=['text','email','tel'].includes(el.type)?contactKey(el):null;
    const key=contact||'portal_'+createHash('sha256').update(JSON.stringify([label,el.name,el.type,el.required,options])).digest('hex').slice(0,24);
    if(seen.has(key)) return stop('Das Formular enthält mehrdeutige Felder.');
    seen.add(key);
    const answer=answers.get(key);
    const value=key==='full_name'?[answers.get('first_name')?.value,answers.get('last_name')?.value].filter(Boolean).join(' '):answer?.value;
    if(!contact&&!answer) {
      additions.push({key,label,type:el.type,required:el.required,options,value:''});
      continue;
    }
    if(inspectOnly) continue;
    if(!value) {
      if(el.required) return stop('Bitte unter Antworten ergänzen: '+label);
      if(el.populated||el.checked) return stop('Das Portal hat eine ungeprüfte Antwort vorbelegt: '+label);
      continue;
    }
    if(el.type==='select-one') actions.push(()=>field.selectOption({label:value}));
    else actions.push(()=>field.fill(value));
  }
  if(inspectOnly) return {fields:additions};
  if(additions.length) return checkboxReview(additions);
  if(finalStep && ['cv','letter'].some(kind=>!fileKinds.has(kind)&&!uploaded.has(kind)))
    return stop('Das Portal bietet keine eindeutigen Uploadfelder für beide freigegebenen PDFs.');
  for(const run of actions) await run();
  const finalCheckboxes=await inspectCheckboxes(scope,job.answers,address);
  if(finalCheckboxes.message) return stop(finalCheckboxes.message);
  if(finalCheckboxes.fields.length) return checkboxReview(finalCheckboxes.fields);
  for(const apply of finalCheckboxes.actions) await apply();
  return null;
}

export async function submitHosted(page,job,documents,{portal,headless,onSubmit,onLogin}) {
  const uploaded=new Set();
  const matchesJob=()=>hostedPortal(page.url())?.apply===portal.apply&&(/\/apply(?:\/|$)|\/applications\/new\/?$/.test(new URL(page.url()).pathname));
  const stop=message=>({status:'blocked',message});
  if(portal.provider==='JOIN'&&(!matchesJob()||await page.locator('input[type=password]:visible,input[autocomplete=one-time-code]:visible').count()||
    await page.getByRole('button',{name:/sign in|log in|anmelden|login|anmeldelink|magic link/i}).count())) {
    if(headless) return stop('Öffne JOIN im sichtbaren Versandbrowser und melde dich an.');
    await onLogin?.();
    // The applicant handles the provider's own login in this temporary browser.
    // Accept a verified tab opened by the applicant in this context only.
    const end=Date.now()+180000;
    let signedIn=false;
    while(Date.now()<end&&!signedIn) {
      for(const candidate of page.context().pages()) {
        if(hostedPortal(candidate.url())?.apply===portal.apply&&new URL(candidate.url()).pathname.includes('/apply')&&
          await candidate.locator('input[type=file],textarea:visible,input[autocomplete=given-name]:visible').count()) {
          page=candidate;signedIn=true;break;
        }
      }
      if(!signedIn) await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!signedIn) return stop('Die Anmeldung für diese JOIN-Stelle wurde nicht abgeschlossen.');
  }
  const submitName=/^(submit application|apply now|send application|send my application|bewerbung (jetzt )?(absenden|senden|abschicken|einreichen)|jetzt bewerben|bewerbung verbindlich absenden)$/i;
  for(let step=0;step<10;step++) {
    if(!matchesJob()) return stop('Das Portal zeigt eine andere Stelle oder eine Anmeldung.');
    if(await page.locator('input[type=password]:visible,iframe[title*="captcha" i]:visible,iframe[title*="challenge" i]:visible').count())
      return stop('Das Portal verlangt eine persönliche Verifizierung.');
    const submit=page.getByRole('button',{name:submitName});
    const captured=await hostedStep(page,job,documents,uploaded,false,await submit.count()===1);
    if(captured) return captured;
    if(!matchesJob()) return stop('Das Bewerbungsziel hat sich geändert.');
    if(await page.locator('input:visible:invalid,select:visible:invalid,textarea:visible:invalid').count())
      return stop('Das Portal meldet einen ungültigen oder fehlenden Feldwert.');
    if(await submit.count()===1) {
      if(!uploaded.has('cv')||!uploaded.has('letter')) return stop('Das Portal hat keine eindeutigen Uploadfelder für beide freigegebenen PDFs angeboten.');
      await submit.click({trial:true,timeout:10000});
      const action=await submit.evaluate(b=>b.getAttribute('formaction')||b.form?.action||location.href);
      const destination=new URL(action,page.url());
      if(destination.origin!==new URL(portal.apply).origin||(hostedPortal(destination.href)&&hostedPortal(destination.href).apply!==portal.apply)) return stop('Das Formular verweist auf ein fremdes Versandziel.');
      await onSubmit();
      await submit.click({timeout:8000});
      await page.waitForFunction(()=>!document.querySelector('input[type=file]')&&/thank you for (applying|your application)|application (?:has been |was )?(received|submitted|sent)|vielen dank für (deine|ihre) bewerbung|bewerbung (ist eingegangen|wurde.{0,25}(übermittelt|versendet|eingereicht|gesendet))/i.test(document.body.innerText),undefined,{timeout:12000});
      if(new URL(page.url()).origin!==new URL(portal.apply).origin) throw new Error('Unbestätigter Eingang');
      return {status:'sent',message:'Das Firmenportal bestätigt den Eingang der Bewerbung.',confirmationUrl:page.url()};
    }
    const next=page.getByRole('button',{name:/^(weiter|nächster schritt|continue|next|next step)$/i});
    if(portal.provider!=='JOIN'||await next.count()!==1||!await next.isEnabled()) return stop('Kein eindeutiger nächster Schritt im Bewerbungsformular.');
    const before=await page.locator('body').innerText();
    const previous=page.url();
    await next.click();
    await page.waitForFunction(([url,text])=>location.href!==url||document.body.innerText!==text,[previous,before],{timeout:8000});
  }
  return stop('Das Portal enthält weitere Schritte, die eine persönliche Prüfung benötigen.');
}

export async function publicHostedListing(raw,portal) {
  const link=new URL(raw);
  link.search='';link.hash='';link.pathname=link.pathname.replace(/\/applications\/new\/?$/,'').replace(/\/apply(?:\/[a-zA-Z]+)?\/?$/,'');
  const res=await fetch(link.href,{redirect:'error',signal:AbortSignal.timeout(9000)});
  if(!res.ok) throw new Error('Die öffentliche Einzelanzeige ist nicht erreichbar.');
  const html=await res.text();
  const records=[];
  for(const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data=JSON.parse(match[1]);
      for(const node of [].concat(data)) records.push(node,...(Array.isArray(node?.['@graph'])?node['@graph']:[]));
    } catch { /* Other structured data on the same page may be unrelated. */ }
  }
  const jobs=records.filter(node=>[].concat(node?.['@type']).includes('JobPosting'));
  if(jobs.length!==1) throw new Error('Die Einzelanzeige ist nicht eindeutig lesbar. Nutze die Firmenrecherche im Projektchat.');
  const j=jobs[0];
  if(Date.parse(j.validThrough)<Date.now()) throw new Error('Die Ausschreibung ist abgelaufen.');
  const plain=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
  const employer=plain(j.hiringOrganization?.name),title=plain(j.title),description=plain(j.description).slice(0,16000);
  if(!employer||!title||!description) throw new Error('Firma oder Aufgaben sind in der Einzelanzeige nicht erkennbar.');
  const location=[].concat(j.jobLocation||[]).map(l=>l.address?.addressLocality).filter(Boolean).join(', ')||(j.jobLocationType==='TELECOMMUTE'?'Remote':'Offen');
  return {employer,title,description,location,target:link.href,portal:portal.provider};
}
