const app = document.querySelector('#app');
const dialog = document.querySelector('#review-dialog');
let state;
const hashPages={'#anbieter':'connection','#schreibvorlage':'template','#unterlagen':'documents','#stellen':'applications'};
let page = hashPages[location.hash] || 'overview';
let selected = null;
let tab = 'letter';
let listings = [];
let filter = 'all';
let busy = false;
let providers = {};
let search = { url:'', query:'', place:'', boards:[] };
let searched = false;
let searchExpanded = false;
let editingPreferences=false;
let searchSources = null;
let webTask=sessionStorage.getItem('research-task');
let checkingWeb=false;
let preparing = null;
let claudePrompt = '';
let nativeTask = null;
let templateHelpOpen = false;
const unsaved = new Map();
const editForms = ['letter-form','answers-form'];
const get = path => api(path,undefined,'GET');
const live = () => state.mode==='live';
const pageNames = {overview:'Start',applications:'Bewerbungen',documents:'Unterlagen',template:'Schreibvorlage',connection:'KI-Anbieter'};
const arrow = '<span aria-hidden="true">→</span>';
const route = (page,label,kind='secondary') => `<button type="button" class="button ${kind}" data-page="${page}">${label} ${arrow}</button>`;
const lastDocument = kind => state.documents.find(doc=>doc.kind===kind);
const ready = () => state.profile.name && state.profile.email && lastDocument('cv');

let toastTimer;
const labels = { prepared:'Vorbereitet',approved:'Freigegeben',sending:'Im Versand',sent:'Bestätigt versandt',unknown:'Ausgang unklar',blocked:'Angehalten' };
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = value => new Date(value).toLocaleString('de-DE',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
const badge = status => `<span class="status ${status}"><span aria-hidden="true">${{prepared:'◷',approved:'✓',sending:'↗',sent:'✓',unknown:'?',blocked:'!'}[status]}</span>${labels[status]}</span>`;
const current = () => state.jobs.find(job=>job.id===selected);
function notify(message,error=false) {
  const toast=document.querySelector('#toast'); clearTimeout(toastTimer); toast.textContent=message;toast.className=`show ${error?'error':''}`;toastTimer=setTimeout(()=>toast.className='',6500);
}
async function api(path,body,method='POST') {
  const result=await fetch(`/api${path}`,{method,headers:body?{'Content-Type':'application/json','X-CSRF-Token':state.csrf}:{},body:body?JSON.stringify(body):undefined});
  const data=await result.json(); if(!result.ok) throw new Error(data.error||'Die Aktion konnte nicht abgeschlossen werden.'); return data;
}
async function refresh() {
  const next=await api('/state',undefined,'GET');
  const cvId=s=>s.documents.find(d=>d.kind==='cv')?.id;
  if(state&&cvId(state)!==cvId(next)) {
    listings=[]; searched=false; webTask=null; sessionStorage.removeItem('research-task');
  }
  if(!state||cvId(state)!==cvId(next)) search.place=next.preferences?.place||'';
  state=next; if(!selected&&state.jobs.length) selected=state.jobs[0].id; render();
}
function navigate(next) {
  page=next;
  render();
  document.querySelector('#main').focus({preventScroll:true});
  window.scrollTo(0,0);
  if(page==='connection' && live()) checkProviders();
}
window.addEventListener('hashchange',()=>{
  const next=hashPages[location.hash];
  if(next&&state) navigate(next);
});
async function checkProviders() {
  const next=await Promise.all(['codex','claude'].map(async provider=>{
    try { return [provider,await get(`/providers/${provider}`)]; }
    catch(error) { return [provider,{status:'unavailable',help:error.message}]; }
  }));
  providers=Object.fromEntries(next);
  if(page==='connection') {
    const focused=document.activeElement?.id;
    render();
    if(focused) document.getElementById(focused)?.focus();
  }
}
async function action(task, showError = message=>notify(message,true)) {
  if(busy)return;
  const previousPage=page;
  const focused=document.activeElement?.id;
  busy=true;
  document.body.classList.add('working');
  try {
    await task();
    await refresh();
    if(!dialog.open) {
      const next=previousPage===page && focused && document.getElementById(focused);
      (next||document.querySelector('#main')).focus();
    }
  } catch(error) {
    showError(error.message);
  } finally {
    busy=false;
    document.body.classList.remove('working');
  }
}
const input = (label,name,value,extra='') => `<label>${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;

function render() {
  const docs=state.documents.filter(d=>d.kind==='cv');
  app.innerHTML=`<header class="masthead"><div class="masthead-inner">
    <a class="brand" href="/" data-page="overview"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>Meine Bewerbungen</a>
    <button class="nav-toggle" type="button" aria-controls="main-nav" aria-expanded="false">Menü</button>
    <nav id="main-nav" aria-label="Hauptnavigation">${Object.entries(pageNames).map(([key,label])=>`<button type="button" data-page="${key}" ${page===key?'aria-current="page"':''}>${label}</button>`).join('')}</nav>
    <span class="mode ${live()?'mode-live':'mode-demo'}">${live()?'Eigene Daten':'Beispielmodus'}</span>
  </div></header>
  <main id="main" class="${page==='overview'?'home':''}" tabindex="-1">${pageContent(docs)}</main>
  <footer class="app-footer"><a href="/anleitung.html" target="_blank" rel="noopener">Anleitung öffnen <span aria-hidden="true">↗</span></a></footer>`;
  bind();
}
function title(heading,description,extra=''){return `<div class="page-heading"><div><h1>${heading}</h1><p>${description}</p></div>${extra}</div>`;}
function demoAction(docs) {
  const label=docs.length?'Beispiel öffnen':'Mit Beispieldaten ausprobieren';
  if(!live()) return `<button class="button ${docs.length?'secondary':'primary'}" id="load-demo">${label} ${arrow}</button>`;
  return state.entry?.demo?`<a class="button secondary" href="${esc(state.entry.demo)}">Mit Beispieldaten ausprobieren ${arrow}</a>`:'';
}
function realAction(){
  if(live()) return lastDocument('cv')?route('applications','Passende Stellen finden','primary'):route('documents','Lebenslauf hinzufügen','primary');
  if(state.entry?.live) return `<a class="button secondary" href="${esc(state.entry.live)}#unterlagen">Eigene Bewerbung vorbereiten ${arrow}</a>`;
  return route('connection','Eigene Bewerbung vorbereiten');
}
function pageContent(docs) {
  if(page==='documents') return documentsPage(docs);
  if(page==='template') return templatePage();
  if(page==='connection') return connectionPage();
  if(page==='applications') return applicationsPage();
  if(state.jobs.length) return inboxPage();

  const cv=lastDocument('cv');
  const sample=lastDocument('sample');
  return `<header class="workspace-heading"><h1>Meine Bewerbungen</h1></header>
    <div class="intake">
      <section class="intake-main">
        <h2>${live()?(cv?'Passende Stellen finden':'Deinen Lebenslauf hinzufügen'):'Eine Bewerbung ausprobieren'}</h2>
        <p>${live()?(cv?'Dein Lebenslauf liegt bereit. Suche nach Stellen, die zu deiner Erfahrung passen.':'Aus deinem Lebenslauf ermitteln wir, welche Stellen zu deiner Erfahrung passen.'):'Probier die Stellensuche, das Anschreiben und die Freigabe mit einer fiktiven Bewerbung aus.'}</p>
        ${live()&&!cv?`<div id="cv-drop" class="cv-drop"><span class="file-glyph" aria-hidden="true">PDF</span>
          <strong>Lebenslauf hierher ziehen</strong><span id="file-limits">PDF mit auswählbarem Text · bis 8 MB</span>
          <label class="button primary file-button">Datei auswählen<input id="cv-file" type="file" accept=".pdf,application/pdf" aria-describedby="file-limits"></label>
        </div>`:`<div class="intake-action">${live()?realAction():demoAction(docs)}</div>`}
      </section>
      <aside class="intake-files"><h2>Deine Unterlagen</h2>
        <dl><div><dt>Lebenslauf</dt><dd>${cv?esc(cv.name):'Noch nicht hinterlegt'}</dd></div>
        <div><dt>Schreibvorlage</dt><dd>${sample?esc(sample.name):'Optional'}</dd></div></dl>
        <button type="button" data-page="template" class="text-button">${sample?'Schreibvorlage ansehen':'Eigenes Muster hinzufügen'} ${arrow}</button>
      </aside>
    </div><div class="mode-link">${live()?demoAction([]):realAction()}</div>`;
}
function inboxPage(){
  const job=current()||state.jobs[0];
  const letter=job.letter||'Für diese Bewerbung ist noch kein Anschreiben hinterlegt.';
  return `<header class="workspace-heading"><h1>Meine Bewerbungen</h1><button class="button secondary" type="button" id="open-search">Zur Stellensuche ${arrow}</button></header>
    <div class="inbox"><section class="inbox-list" aria-label="Stellenauswahl">
      <h2>Bewerbungen <span>${state.jobs.length}</span></h2>
      ${state.jobs.map(j=>`<button class="inbox-item" data-preview-job="${esc(j.id)}" aria-pressed="${j.id===job.id}">
          <small>${esc(j.employer)}</small><strong>${esc(j.title)}</strong><span>${esc(labels[j.status])}</span></button>`).join('')}
    </section>
    <article class="inbox-reader" id="preview-letter" tabindex="-1"><header>
      <div class="reader-source">${esc(job.employer)}${job.location?' · '+esc(job.location):''}</div><h2>${esc(job.title)}</h2>
      <div class="reader-tools">${badge(job.status)}<button class="button primary" data-job="${esc(job.id)}">Bewerbung prüfen</button></div>
    </header><h3>Anschreiben</h3><div class="reader-text">${esc(letter)}</div></article></div>`;
}
function empty(heading,text,button,nav){return `<div class="empty"><h3>${heading}</h3><p>${text}</p>${button?route(nav,button):''}</div>`;}
function documentsPage(docs){return `${title('Unterlagen','Hinterlege deinen Lebenslauf und die Angaben für Bewerbungsformulare.',docs.length?route('applications','Jetzt Stellen finden','primary'):'')}
  <div class="documents-grid"><section class="panel"><div class="section-top"><h2>Lebenslauf</h2><span class="small muted">PDF · bis 8 MB</span></div>${docs.length?`<a class="document-tile" href="/api/documents/${docs[0].id}" download><span class="pdf-symbol">PDF</span><div><strong>${esc(docs[0].name)}</strong><small>PDF herunterladen</small></div><span aria-hidden="true">↓</span></a>`:empty('Dein Lebenslauf fehlt noch.','Wähle eine PDF-Datei mit deinem Lebenslauf.')}
  ${state.mode==='live'?'<label class="button secondary file-button">PDF auswählen<input id="cv-file" type="file" accept="application/pdf"></label>':'<p class="hint">Der Beispielmodus verwendet den fiktiven Lebenslauf von Mira Beispiel.</p>'}</section>
  <section class="panel"><h2>Profil</h2><p class="muted small">Vor der Suche bestätigst du dein Suchprofil. Name und E-Mail werden dort aus dem Lebenslauf vorgeschlagen.</p><form id="profile-form" class="form-stack"><div class="two-fields">${input('Vollständiger Name','name',(state.preferences?.cvId===lastDocument('cv')?.id?state.profile.name:state.profile.name||state.contactSuggestions?.name),'autocomplete="off" required')}${input('E-Mail','email',(state.preferences?.cvId===lastDocument('cv')?.id?state.profile.email:state.profile.email||state.contactSuggestions?.email),'type="email" required')}</div><div class="two-fields">${input('Telefon','phone',state.profile.phone)}${input('Wohnort','city',state.profile.city)}</div>${input('Kündigungsfrist oder Verfügbarkeit','notice',state.profile.notice)}<label>Deine Suchkriterien<textarea name="criteria" rows="2" placeholder="Rollen, Ort, Arbeitsumfang, Gehalt, Arbeitsmodell">${esc(state.profile.criteria)}</textarea></label><label>Belegte Erfahrungen und Qualifikation<textarea name="evidence" rows="6" placeholder="Welche Aufgaben hast du übernommen? Welche Weiterbildung hast du abgeschlossen?">${esc(state.profile.evidence)}</textarea></label><button class="button primary" type="submit">Profil lokal speichern</button></form></section></div>`;}
function templatePage() {
  const sample=lastDocument('sample');
  const picker=`<label class="button ${sample?'secondary':'primary'} file-button">${sample?'PDF austauschen':'Muster-PDF auswählen'}<input id="sample-file" type="file" accept=".pdf,application/pdf" aria-describedby="sample-hint"></label>`;
  const previewLink=state.entry?.live?`<a class="button secondary" href="${esc(state.entry.live)}#schreibvorlage">Eigenes Muster hinzufügen ${arrow}</a>`:'';
  return `${title('Schreibvorlage','Hier bestimmst du den Ton deiner Anschreiben.',route('applications','Weiter zur Stellenanzeige'))}
    <div class="template-flow">
      <section class="panel sample-panel">
        <div class="sample-content"><h2>${live()?(sample?'Dein Musteranschreiben':'Ein Anschreiben von dir'):'Beispielvorlage'}</h2>
          <p>${live()?(sample?'Diese PDF gibt Ton und Aufbau vor. Welche Erfahrungen im neuen Anschreiben stehen, entscheiden die Stelle und dein Lebenslauf.':'Wähle ein früheres Anschreiben, das nach dir klingt. Für jede Stelle entsteht daraus ein neuer Text mit passenden Erfahrungen aus deinem Lebenslauf.'):'So sieht ein hinterlegtes Muster aus. Für eigene Anschreiben kannst du eine PDF in deinem Arbeitsbereich auswählen.'}</p>
        ${live()?`
          ${sample?`<a class="document-tile active-sample" href="/api/documents/${sample.id}" download>
            <span class="pdf-symbol">PDF</span><div><strong>${esc(sample.name)}</strong><small>Aktive Vorlage · PDF herunterladen</small></div><span aria-hidden="true">↓</span>
          </a>`:''}
          <div class="sample-actions">${picker}${sample?'<button id="remove-sample" class="text-button" type="button">Muster entfernen</button>':''}</div>
          <p class="hint" id="sample-hint">${sample?'Das Muster wird beim Erstellen eines Entwurfs nach deiner Bestätigung verwendet.':'PDF bis 8 MB mit auswählbarem Text. Eine Datei genügt.'}</p>
          <p class="notice warning" id="sample-error" role="alert" hidden></p>
        `:previewLink}</div>
      </section>
      ${sample?'':`<details class="panel template-alternative" ${templateHelpOpen?'open':''}>
        <summary>${live()?'Ich habe kein Musteranschreiben':'Vorlage im Beispielmodus bearbeiten'}</summary>
        <div class="alternative-content">
          <p class="hint">Beantworte drei kurze Fragen. Daraus erstellen wir Hinweise für deine künftigen Anschreiben.</p>
          <form id="template-guide" class="form-stack">
            <label>Welche Aufgabe aus deinem Beruf soll im Anschreiben vorkommen?<textarea name="experience" rows="3" required placeholder="Zum Beispiel ein Prüfaufbau, den du entwickelt hast">${esc(state.profile.evidence)}</textarea></label>
            <label>Was möchtest du in der nächsten Stelle machen?<textarea name="motivation" rows="3" required placeholder="Zum Beispiel Versuche planen und auswerten">${live()?'':'Ich möchte Prüfsysteme entwickeln und die Ergebnisse direkt mit der Entwicklung besprechen.'}</textarea></label>
            <label>Wie möchtest du klingen?<select name="tone"><option>Direkt und fachlich</option><option>Warm und persönlich</option><option>Kurz und sachlich</option></select></label>
            <button class="button primary" type="submit">Vorlage aus meinen Antworten erstellen</button>
          </form>
          <details class="template-editor" ${state.template&&live()?'open':''}><summary>${state.template?'Gespeicherte Hinweise bearbeiten':'Hinweise selbst schreiben'}</summary>
            <form id="template-form" class="form-stack"><label for="template-text">Hinweise für künftige Anschreiben<textarea id="template-text" name="text" rows="8">${esc(state.template)}</textarea></label><button class="button secondary" type="submit">Vorlage speichern</button></form>
          </details>
        </div>
      </details>`}
    </div>`;
}
function providerCard(key,heading,description) {
  const info=providers[key];
  const states={ready:'Angemeldet',signed_out:'Anmeldung erforderlich',missing:'Installation erforderlich',manual:'Im Claude-Code-Chat starten',unavailable:'Derzeit nicht verfügbar',opened:'Anmeldung geöffnet'};
  return `<section class="panel provider-card">
    <h2>${heading}</h2><p>${description}</p>
    <p class="provider-state" role="status">${info?esc(states[info.status]||info.status):'Status wird geprüft…'}</p>
    ${info?.help?`<p class="hint">${esc(info.help)}</p>`:''}
    <div class="provider-actions">
      ${info?.installUrl?`<a class="button secondary" href="${esc(info.installUrl)}" target="_blank" rel="noopener noreferrer">Offizielle Anleitung ↗</a>`:''}
      ${key==='codex' && info?.status==='missing'?'<button id="codex-install" class="button primary">Codex installieren</button>':''}
      ${key==='codex' && info?.status==='signed_out'?'<button id="codex-login" class="button primary">Bei ChatGPT anmelden ↗</button>':''}
      ${['ready','manual'].includes(info?.status)?`<button class="button primary" id="select-${key}" data-provider="${key}">${state.provider===key?'Weiter zu Unterlagen':key==='codex'?'ChatGPT verwenden':'Claude verwenden'} ${arrow}</button>`:''}
    </div>
  </section>`;
}
function connectionPage() {
  return `${title('KI-Anbieter wählen',live()?'Wähle, wie du Entwürfe erstellen möchtest.':'Der Beispielmodus erstellt einen fiktiven Entwurf direkt in der Anwendung.')}${live()?`
    <div class="provider-grid">
      ${providerCard('codex','Mit ChatGPT','Erstellt Entwürfe über die offizielle Codex-App für die Kommandozeile. Dabei gilt das Codex-Kontingent deines angemeldeten ChatGPT-Kontos.')}
      ${providerCard('claude','Mit Claude Code','Der Auftrag wird an den lokal geöffneten Projekt-Skill übergeben. Claude Code nutzt dein angemeldetes Konto.')}
    </div>
    <button class="text-button recheck" id="check-providers">Anmeldestatus prüfen</button>
    `:`<div class="panel connection"><h2>Eigene Bewerbungen</h2><p>Öffne den eigenen Arbeitsbereich für deine Unterlagen und die Verbindung zu ChatGPT oder Claude.</p><div class="provider-actions">${state.entry?.live?realAction():''}${demoAction(lastDocument('cv')?[lastDocument('cv')]:[])}</div>${state.entry?.live?'':'<p class="hint">Der eigene Arbeitsbereich ist bei diesem Demostart nicht verfügbar.</p>'}</div>`}`;
}
function exportOverview() {
  const date=new Date().toLocaleDateString('de-DE');
  const rows=state.jobs.map(job=>`<tr><td>${esc(job.employer)}</td><td>${esc(job.title)}</td><td>${esc(labels[job.status])}</td></tr>`).join('');
  const html=`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Meine Bewerbungen – Übersicht</title><style>body{font:16px/1.5 system-ui;background:#f5f6f8;color:#172031;margin:0;padding:24px}main{max-width:760px;margin:auto}h1{letter-spacing:-.04em}table{background:white;width:100%;border-collapse:collapse;text-align:left}th,td{padding:12px;border-bottom:1px solid #d2d9e4;overflow-wrap:anywhere}p{color:#485568}</style></head><body><main><h1>Meine Bewerbungen</h1><p>${state.mode==='demo'?'Fiktive Beispieldaten · ':''}Stand ${esc(date)}. Die Datei zeigt den gespeicherten Stand.</p><table><thead><tr><th>Firma</th><th>Stelle</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
  const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
  const link=document.createElement('a');
  link.href=url;
  link.download='Meine-Bewerbungen.html';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function searchProfilePage() {
  const p=state.preferences||{};
  const proposed=state.contactSuggestions||{};
  const confirmed=p.cvId===lastDocument('cv')?.id;
  return `<form id="search-profile" class="form-stack"><h3>Dein Suchprofil</h3>
    <p class="muted">Prüfe die Angaben vor der Suche. Freie Felder bleiben offen. Die Gehaltsuntergrenze dient der Suche, der Gehaltswunsch den Bewerbungsformularen.</p>
    <div class="two-fields">${input('Frühester Starttermin','start',p.start,'type="date"')}${input('Kündigungsfrist','notice',p.notice??state.profile.notice,'placeholder="z. B. vier Wochen zum Monatsende"')}</div>
    <div class="two-fields">${input('Gehaltsuntergrenze · EUR brutto/Jahr','minimum',p.minimum,'type="number" min="1" max="10000000"')}${input('Gehaltswunsch · EUR brutto/Jahr','salary',p.salary,'type="number" min="1" max="10000000"')}</div>
    <div class="two-fields">${input('Gewünschte Wochenstunden','hours',p.hours,'type="number" min="1" max="100" step="0.5"')}${input('Gewünschter Arbeitsort','place',p.place,'maxlength="160"')}</div>
    ${input('Berufsbezeichnung aus dem Lebenslauf für die Firmenrecherche (optional)','occupation',p.occupation,'maxlength="90"')}
    <label>Arbeitsmodell<select name="workplace">${['','Hybrid','Remote','Vor Ort'].map(v=>`<option value="${v}" ${v===p.workplace?'selected':''}>${v||'Offen'}</option>`).join('')}</select></label>
    <h3>Kontaktdaten für die Portale</h3><p class="hint">Erkannte Angaben aus dem Lebenslauf sind vorbelegt. Prüfe die Schreibweise. Weitere Kontaktdaten kannst du unter Unterlagen ergänzen.</p>
    <div class="two-fields">${input('Vollständiger Name','name',confirmed?state.profile.name:(proposed.name||state.profile.name),'maxlength="160" autocomplete="name"')}${input('E-Mail','email',confirmed?state.profile.email:(proposed.email||state.profile.email),'type="email" maxlength="200" autocomplete="email"')}</div>
    <button class="button primary" type="submit">Suchprofil speichern</button>
  </form>`;
}
function applicationsPage() {
  const job=current();
  const needsProfile=live()&&lastDocument('cv')&&(editingPreferences||state.preferences?.cvId!==lastDocument('cv').id);
  const visible=state.jobs.filter(j=>filter==='all'||j.status===filter);
  return `${title('Bewerbungen',live()?'Finde passende Stellen und prüfe jede Bewerbung vor dem Versand.':'Bereite eine fiktive Bewerbung vor und teste die Freigabe.',state.jobs.length?'<button class="button secondary" id="export-overview" type="button">Übersicht als HTML speichern</button>':'')}
    ${state.jobs.length?`<details class="new-application" ${searchExpanded?'open':''}><summary>${live()?'Stellen suchen oder hinzufügen':'Weitere Beispielstelle vorbereiten'}</summary>`:''}
    <section class="panel search-panel"><h2>${live()?'Passende Stellen finden':'Beispielstelle finden'}</h2>
      ${needsProfile?searchProfilePage():live()?`<p>Die App durchsucht Stellenbörsen und Firmen direkt. Dein Projektchat kann weitere passende Arbeitgeber und Zulieferer finden. Dafür erhält er Fachgebiete oder passende öffentliche Stellentitel und deinen Suchort.</p>
        ${lastDocument('cv')?'<button class="text-button" id="edit-preferences">Suchprofil bearbeiten</button>':''}
        <form id="search-form"  class="form-stack">
          <div class="two-fields">
            ${input('Ort oder Remote (optional)','place',search.place,'placeholder="Zum Beispiel München, Remote"')}
            ${input('Rolle oder Stichwörter (optional)','query',search.query,'placeholder="Zum Beispiel Testing, Beratung"')}
          </div>
          <details class="search-options"><summary>Weitere Firmenportale einbeziehen</summary><label>Greenhouse-Firmenlinks<textarea name="boards" rows="2" placeholder="https://job-boards.greenhouse.io/firma">${esc(search.boards.join('\n'))}</textarea></label><p class="hint">Bis zu fünf Links. Pro Zeile ein Firmenportal.</p></details>
          ${lastDocument('cv')?'<button class="button primary" type="submit">Stellen nach Lebenslauf suchen '+arrow+'</button>':route('documents','Lebenslauf hinzufügen','primary')}
        </form>
        ${lastDocument('cv')?`<details class="search-options"><summary>Weitere Jobbörsen und Karriereseiten durchsuchen</summary><p class="hint">Dein Chat-Agent sucht zusätzlich bei passenden Firmen, ihren Zulieferern und auf Jobbörsen. Treffer mit belegten Aufgaben erscheinen in dieser Liste.</p><button id="web-research" class="button secondary" type="button">Webrecherche starten</button>${webTask?`<p role="status">Der Auftrag liegt bereit. Öffne deinen Projektchat und starte <code>${state.provider==='claude'?'/meine-bewerbungen':'$meine-bewerbungen'}</code>. Treffer erscheinen hier.</p>`:''}</details>
        <details class="search-options direct-search"><summary>Ich habe schon eine Stellenanzeige</summary>
          <form id="direct-search-form" class="form-stack"><label>Link zur Stellenanzeige<input id="job-url" name="url" type="url" required placeholder="https://…" value="${esc(search.url)}"></label>
          <p class="hint">Einzelanzeige bei Greenhouse, Personio, JOIN, Lever oder Teamtailor.</p><button class="button secondary" type="submit">Stellenanzeige laden ${arrow}</button></form>
        </details>`:''}`:`<form id="search-form" class="form-stack"><p class="hint">Entwicklungsingenieur:in Prüfsysteme bei Nordstern Systeme.</p><button class="button primary" type="submit">Beispielstelle suchen ${arrow}</button></form>`}
    </section>
    ${webTask&&live()?'<p class="hint" role="status">Weitere Firmen und Zulieferer werden über den Projektchat recherchiert. Öffne bei Bedarf den Projektchat mit dem installierten Skill. Die Ergebnisse erscheinen hier.</p>':''}
    ${searched?`<section class="search-results"><div class="section-top"><h2>${searchSources?'Vorschläge aus der Stellensuche':live()?'Gefundene Anzeige':'Gefundene Beispielstelle'}</h2></div>
      ${searchSources?`<p class="hint search-count">${searchSources.checked} von ${searchSources.total} Quellen erreichbar · ${listings.length} Vorschläge</p>`:''}
      ${listings.length?listings.map((j,i)=>`<article class="result"><div><span class="company-name">${esc(j.employer)}</span><h3>${esc(j.title)}</h3><p>${esc(j.location)}${live()?' · '+esc(j.portal||'Greenhouse'):''}</p><p>${esc(j.description.slice(0,240))}${j.description.length>240?'…':''}</p>${j.matchesProfile?.length?`<p><strong>Überschneidungen mit dem Lebenslauf</strong> · ${esc(j.matchesProfile.join(', '))}</p>`:''}${j.preferenceNotes?.length?`<p>${esc(j.preferenceNotes.join(' · '))}</p>`:''}${j.target?`<p><a href="${esc(j.target)}" target="_blank" rel="noopener noreferrer">Originalanzeige öffnen ↗</a> · ${j.source?.region==='external'?'Persönlicher Versand':j.source?.region==='hosted'?'Portalversand nach Formularprüfung':'Portalversand verfügbar'}</p>`:''}</div><button class="button secondary prepare" data-index="${i}" ${!ready()?'disabled':''}>Bewerbung vorbereiten ${arrow}</button></article>`).join(''):`<p>${searchSources?'Keine weiteren passenden Stellen gefunden. Erweitere den Ort oder füge weitere Firmenportale hinzu.':'Keine Anzeige gefunden.'}</p>`}
      ${listings.length&&!ready()?`<div class="steps-needed"><p>Für den Entwurf brauchst du dein Profil und einen Lebenslauf.</p>${route('documents','Unterlagen ergänzen')}</div>`:''}
    </section>`:''}
    ${state.jobs.length?'</details>':''}
    <div class="section-top applications-heading"><h2>Meine Bewerbungen <span class="muted">${state.jobs.length}</span></h2>${state.jobs.length?`<label class="filter-label"><span class="sr-only">Nach Status filtern</span><select id="status-filter"><option value="all">Alle Status</option>${Object.entries(labels).map(([key,label])=>`<option value="${key}" ${filter===key?'selected':''}>${label}</option>`).join('')}</select></label>`:''}</div>
    ${state.jobs.length?`<div class="review-layout"><section class="application-list" aria-label="Bewerbungsauswahl">${visible.map(j=>`<button class="application-item ${selected===j.id?'active':''}" data-job="${j.id}" ${selected===j.id?'aria-current="true"':''}><span class="company-name">${esc(j.employer)}</span><strong>${esc(j.title)}</strong><small>${esc(j.location)}</small>${badge(j.status)}</button>`).join('')||'<p>Keine Bewerbung mit diesem Status.</p>'}</section><section class="review-panel">${job&&visible.includes(job)?review(job):empty('Wähle eine Bewerbung.','Der vollständige Entwurf erscheint hier.')}</section></div>`:empty('Noch keine Bewerbungen','Sobald du einen Entwurf erstellst, erscheint er hier.')}`;
}

async function prepare(source,handoff={}) {
  const result=await api('/prepare',{source,...(live()?{consent:true,...handoff}:{})});
  selected=result.id;
  filter='all';
  tab='letter';
  listings=listings.filter(item=>item.source.jobId!==source.jobId||item.source.board!==source.board||item.source.region!==source.region);
  searchExpanded=false;
  claudePrompt='';
  nativeTask=null;
  dialog.close();
  notify('Bewerbung zur Durchsicht vorbereitet.');
}
function openPreparation(index) {
  preparing=listings[index];
  claudePrompt='';
  if(nativeTask?.target!==preparing.target) nativeTask=state.nativePending?.find(task=>task.target===preparing.target)||null;
  if(!live()) return action(async()=>{notify('Entwurf wird vorbereitet…');await prepare(preparing.source);});
  renderPreparation();
  dialog.showModal();
}
function renderPreparation() {
  const job=preparing;
  const claude=state.provider==='claude';
  const imported=claude && claudePrompt;
  dialog.innerHTML=`<button class="dialog-close" type="button" aria-label="Vorbereitung schließen">×</button>
    <h2 id="review-title">Entwurf für ${esc(job.employer)}</h2><p class="muted">${esc(job.title)}</p>
    ${nativeTask?`<div class="form-stack"><p>Öffne dieses Projekt in Claude Code. Gib <code>/meine-bewerbungen</code> ein, um Anschreiben und Faktenprüfung zu starten. Die App übernimmt das Ergebnis, sobald es vorliegt.</p>
      <p id="native-state" class="notice" role="status">Warte auf Claude Code …</p>
      <button class="button secondary" id="native-close" type="button">Zum Dashboard</button></div>`:`
    <form id="prepare-form" class="form-stack">
      ${imported?`<p>Kopiere den Text in Claude. Füge die Antwort mit Entwurf und Faktenprüfung anschließend im JSON-Format ein.</p><label>Vorbereitung für Claude<textarea id="claude-prompt" rows="7" readonly>${esc(claudePrompt)}</textarea></label><button class="button secondary" id="copy-prompt" type="button">Text kopieren</button><label>Antwort von Claude (JSON)<textarea id="claude-draft" rows="6" required></textarea></label>`:
      `<p>Die Vorbereitung verwendet Text aus deinem Lebenslauf und ggf. deinem Muster, deinen Namen, deine Hinweise, die Stellenanzeige und die Fragen des Portals. Prüfe vorab, welche persönlichen Angaben deine PDFs enthalten.</p><label class="consent"><input type="checkbox" required>Ich stimme zu, dass ${claude?'Claude diese Daten für Entwurf und Faktenprüfung verarbeitet.':'Codex diese Daten für Entwurf und Faktenprüfung verarbeitet.'}</label>`}
      <div class="notice warning" id="prepare-error" role="alert" hidden></div>
      <p id="prepare-progress" class="hint" role="status" hidden></p>
      <div class="provider-actions">
        <button class="button primary" type="submit" value="auto">${imported?'Claude-Entwurf übernehmen':claude?'Auftrag für Claude Code erstellen':'Entwurf mit ChatGPT erstellen'} ${arrow}</button>
        ${claude&&!imported?'<button class="button secondary" type="submit" value="manual">Text manuell in Claude kopieren</button>':''}
      </div>
    </form>`}`;
  dialog.querySelector('.dialog-close').onclick=()=>dialog.close();
  dialog.querySelector('#native-close')?.addEventListener('click',()=>dialog.close());
  if(nativeTask) return;
  dialog.querySelector('#copy-prompt')?.addEventListener('click',async(event)=>{
    try { await navigator.clipboard.writeText(claudePrompt); event.target.textContent='Text kopiert'; }
    catch { dialog.querySelector('#claude-prompt').select(); }
  });
  dialog.querySelector('#prepare-form').onsubmit=async event=>{
    event.preventDefault();
    if(busy)return;
    const errorBox=dialog.querySelector('#prepare-error');
    const submit=event.submitter;
    const label=submit.textContent;
    busy=true;
    submit.disabled=true;
    submit.textContent='Wird bearbeitet…';
    errorBox.hidden=true;
    try {
      if(claude&&!imported&&submit.value==='auto') {
        const {id}=await api('/native',{source:job.source,consent:true});
        nativeTask={id,source:job.source,target:job.target};
        if(dialog.open) renderPreparation();
      } else if(claude&&!imported) {
        claudePrompt=(await api('/claude/export',{source:job.source,consent:true})).prompt;
        if(dialog.open) {
          renderPreparation();
          dialog.querySelector('#claude-prompt').focus();
        }
      } else {
        let result={};
        if(imported) {
          const raw=dialog.querySelector('#claude-draft').value.trim().replace(/^\`\`\`(?:json)?\s*|\s*\`\`\`$/g,'');
          try { result=JSON.parse(raw); }
          catch { throw new Error('Füge die vollständige JSON-Antwort von Claude ein.'); }
        }
        await prepare(job.source,result);
        await refresh();
        document.querySelector('#main').focus();
      }
    } catch(error) {
      errorBox.textContent=error.message;
      errorBox.hidden=false;
    } finally {
      busy=false;
      submit.disabled=false;
      submit.textContent=label;
    }
  };
}
async function pollPreparation() {
  const task=nativeTask;
  if(task&&(!dialog.open||dialog.querySelector('#native-state'))&&!busy) {
    busy=true;
    try {
      if((await get(`/native/${task.id}`)).status!=='ready') return;
      await prepare(task.source,{nativeId:task.id});
      await refresh();
    } catch(error) {
      nativeTask=null;
      if(dialog.open) {renderPreparation(); const message=dialog.querySelector('#prepare-error'); message.textContent=error.message; message.hidden=false;}
      else notify(error.message,true);
    } finally {busy=false;}
  } else if(dialog.open&&busy&&!task&&dialog.querySelector('#prepare-progress')) {
    try {
      const {stage}=await get('/prepare/progress');
      const element=dialog.querySelector('#prepare-progress');
      if(element){element.hidden=!stage;element.textContent=stage;}
    } catch {}
  }
}
setInterval(pollPreparation,1500);
setInterval(async()=>{
  if(!webTask||!state||busy||checkingWeb||!live()) return;
  checkingWeb=true;
  try {
    const requested=webTask;
    const result=await get('/research/'+requested);
    if(requested!==webTask) return;
    if(result.status!=='ready') return;
    const byTarget=new Map([...listings,...result.listings].map(j=>[j.target,j]));
    listings=[...byTarget.values()];
    searched=true;searchExpanded=true;
    notify(result.listings.length+' passende Treffer aus der Webrecherche.');
  } catch(error){notify(error.message,true);}
  finally {checkingWeb=false;}
  webTask=null;sessionStorage.removeItem('research-task');render();
},3000);
function edits(job) { return unsaved.get(job?.id)||{}; }
function markEdits(job,form) {
  const draft=edits(job);
  const values=Object.fromEntries(new FormData(form));
  const original=form.id==='letter-form'?{letter:job.letter}:Object.fromEntries(job.answers.map(answer=>[answer.key,answer.value]));
  if(Object.keys(values).some(key=>values[key]!==original[key])) draft[form.id]=values;
  else delete draft[form.id];
  unsaved.set(job.id,draft);
  const dirty=Object.keys(draft).length>0;
  const proceed=document.querySelector('#open-review,#send');
  if(proceed) proceed.disabled=dirty;
  const hint=document.querySelector('#review-hint');
  if(hint) hint.textContent=dirty?'Speichere deine Änderungen vor der Freigabe oder dem Versand.':reviewHint(job);
}
function reviewHint(job) {
  if(job.source.region==='external') return 'Prüfe deinen Entwurf und reiche die Unterlagen beim Arbeitgeber ein.';
  return job.status==='approved'?'Diese Fassung ist ausdrücklich freigegeben.':
    job.status==='sent'?'Portalquittung und Verlauf sind gespeichert.':
    job.status==='unknown'?'Bitte den Eingang persönlich prüfen. Der automatische Versand bleibt gesperrt.':
    job.status==='sending'?'Der Versand läuft.':'Prüfe Ziel, Antworten und jede Anlage vor der Freigabe.';
}
function review(job){const dirty=Object.keys(edits(job)).length>0;return `<div class="review-header"><div><span class="company-name">${esc(job.employer)}</span><h2>${esc(job.title)}</h2><p>${esc(job.location)} · Fassung ${job.revision}</p></div>${badge(job.status)}</div><div class="target-line"><span>Zielportal</span><a href="${esc(job.applyTarget||job.target)}" target="_blank" rel="noopener noreferrer">${esc(new URL(job.applyTarget||job.target).host+new URL(job.applyTarget||job.target).pathname)} <span aria-hidden="true">↗</span></a></div>
  ${job.blocker?`<div class="notice warning"><strong>${labels[job.status]}</strong><p>${esc(job.blocker)}</p></div>`:''}${job.confirmation?`<div class="notice success"><strong>Der Eingang wurde vom Portal bestätigt.</strong><p>${esc(job.confirmation.message)}</p><a href="${esc(job.confirmation.url)}" target="_blank" rel="noopener">Portalquittung ansehen ↗</a></div>`:''}
  <div class="fit-note"><strong>Warum diese Aufgabe?</strong><p>${esc(job.fit)}</p>${job.gaps?`<p class="small muted">Offen · ${esc(job.gaps)}</p>`:''}${job.audit?`<details class="fact-check"><summary>Faktenprüfung anzeigen</summary><p>${job.audit.revision===job.revision?esc(job.audit.summary):'Diese Fassung wurde nach der Faktenprüfung bearbeitet. Prüfe die Änderungen vor der Freigabe.'}</p><p class="small muted">${esc(job.audit.method)}</p></details>`:''}</div><div class="tabs" role="tablist" aria-label="Bewerbung prüfen">${[['letter','Anschreiben'],['answers','Antworten'],['files','Unterlagen'],['history','Verlauf']].map(([key,label])=>`<button role="tab" aria-selected="${tab===key}" aria-controls="review-tab-content" tabindex="${tab===key?0:-1}" data-tab="${key}" id="tab-${key}">${label}</button>`).join('')}</div>
  <div class="tab-content" id="review-tab-content" role="tabpanel" tabindex="0" aria-labelledby="tab-${tab}">${reviewBody(job)}</div><div class="review-footer"><p id="review-hint">${dirty?'Speichere deine Änderungen vor der Freigabe oder dem Versand.':reviewHint(job)}</p>${job.source.region==='external'?`<a class="button primary" href="${esc(job.applyTarget||job.target)}" target="_blank" rel="noopener noreferrer">Zur Originalanzeige ↗</a>`:['prepared','blocked'].includes(job.status)?`<button id="open-review" class="button primary" ${dirty?'disabled':''}>Prüfen & freigeben ${arrow}</button>`:job.status==='approved'?`<button id="send" class="button primary" ${dirty?'disabled':''}>Freigegebene Bewerbung absenden ↗</button>`:''}</div>`;}
function answerLinks(answer) {
  return (answer.links||[]).map((link,index)=>`<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Portalhinweis ${index+1} öffnen ↗</a>`).join(' · ');
}
function answerEditor(answer, value, locked) {
  const name=esc(answer.key);
  const label=`${esc(answer.label)} ${answer.required?'<span class="required" aria-hidden="true">*</span><span class="sr-only">Pflichtfeld</span>':''}`;
  const links=answerLinks(answer);
  if(answer.type==='application-consent'&&value==='Ja') {
    const status=locked?'Ja':'Wird mit deiner Freigabe bestätigt';
    return `<div><strong>${label}</strong><div class="small muted">${status}${links?' · '+links:''}</div><input type="hidden" name="${name}" value="Ja"></div>`;
  }
  const control=answer.options.length
    ?`<select name="${name}" ${locked?'disabled':''}><option value="">${answer.type==='checkbox'&&!answer.required?'Häkchen bleibt frei':'Bitte auswählen'}</option>${answer.options.map(o=>`<option ${o===value?'selected':''}>${esc(o)}</option>`).join('')}</select>`
    :`<input name="${name}" value="${esc(value)}" ${locked?'readonly':''}>`;
  return `<div><label><span>${label}</span>${control}</label>${links?`<span class="small">${links}</span>`:''}</div>`;
}
function answerSummary(answer) {
  const isConsent=answer.type==='application-consent';
  const links=answerLinks(answer);
  const value=isConsent&&answer.value==='Ja'?'Wird akzeptiert':answer.value|| (answer.type==='checkbox'&&!answer.required?'Häkchen bleibt frei':'Noch offen');
  return `<div><dt>${esc(answer.label)}${links?`<br>${links}`:''}</dt><dd>${esc(value)}</dd></div>`;
}
function reviewBody(job){const locked=['sending','sent','unknown'].includes(job.status); const draft=locked?{}:edits(job);
  if(tab==='letter')return `<form id="letter-form"><label class="sr-only" for="letter-text">Individuelles Anschreiben bearbeiten</label><textarea id="letter-text" name="letter" class="letter-editor" rows="20" ${locked?'readonly':''}>${esc(draft['letter-form']?.letter??job.letter)}</textarea>${!locked?'<div class="editor-footer"><span class="small muted">Änderungen erzeugen eine neue Fassung und ein neues PDF.</span><button class="button secondary">Text & PDF speichern</button></div>':''}</form>`;
  if(tab==='answers')return `<form id="answers-form" class="form-stack">${job.answers.map(answer=>answerEditor(answer,draft['answers-form']?.[answer.key]??answer.value,locked)).join('')}${!locked?'<button class="button secondary">Antworten speichern</button>':''}</form>`;
  if(tab==='files')return `<div class="form-stack">${job.attachments.map(id=>{const d=state.documents.find(d=>d.id===id);return `<a class="document-tile" href="/api/documents/${id}" target="_blank" rel="noopener"><span class="pdf-symbol">PDF</span><div><strong>${esc(d?.name)}</strong><small>${d?.kind==='cv'?'Lebenslauf':'Individuelles Anschreiben'} · SHA-256 ${esc(d?.hash.slice(0,12))}…</small></div><span aria-hidden="true">↗</span></a>`;}).join('')}<p class="small muted">Die Freigabe gilt für die hier aufgeführten Dateiinhalte.</p></div>`;
  return `<ol class="timeline">${state.events.filter(e=>e.jobId===job.id).map(e=>`<li><span></span><div><p>${esc(e.message)}</p><time>${time(e.time)}</time></div></li>`).join('')}</ol>`;
}

function bind(){
  document.querySelector('#edit-preferences')?.addEventListener('click',()=>{editingPreferences=true;render();document.querySelector('#search-profile input')?.focus();});
  document.querySelector('#search-profile')?.addEventListener('submit',event=>{
    event.preventDefault();
    const {name,email,...preferences}=Object.fromEntries(new FormData(event.currentTarget));
    const cvId=lastDocument('cv').id;
    action(async()=>{
      await api('/search-profile',{name,email,preferences,cvId});
      editingPreferences=false;search.place=preferences.place;listings=[];searched=false;
      webTask=null;sessionStorage.removeItem('research-task');
      notify('Suchprofil gespeichert. Du kannst die Suche jetzt starten.');
    });
  });
  const menu=document.querySelector('.nav-toggle');
  menu.onclick=()=>menu.setAttribute('aria-expanded',String(menu.getAttribute('aria-expanded')!=='true'));
  menu.closest('header').onkeydown=event=>{
    if(event.key==='Escape'&&menu.getAttribute('aria-expanded')==='true') {
      menu.setAttribute('aria-expanded','false'); menu.focus();
    }
  };
  document.querySelectorAll('[data-page]').forEach(el=>el.addEventListener('click',event=>{event.preventDefault();navigate(el.dataset.page);}));
  document.querySelector('#open-search')?.addEventListener('click',()=>{
    searchExpanded=true;
    navigate('applications');
  });
  for(const row of document.querySelectorAll('[data-preview-job]')) {
    row.addEventListener('click',()=>{
      selected=row.dataset.previewJob;
      render();
      if(matchMedia('(max-width:760px)').matches) document.querySelector('#preview-letter').focus();
      else document.querySelector('.inbox-item[aria-pressed=true]').focus();
    });
  }
  const drop=document.querySelector('#cv-drop');
  if(drop) {
    for(const type of ['dragover','dragleave','drop']) drop.addEventListener(type,event=>{
      event.preventDefault();
      drop.classList.toggle('dragging',type==='dragover');
      if(type!=='drop') return;
      const files=event.dataTransfer.files;
      if(files.length!==1) return notify('Bitte einen einzelnen Lebenslauf als PDF wählen.',true);
      const field=drop.querySelector('input');
      field.files=files;
      field.dispatchEvent(new Event('change'));
    });
  }
  document.querySelectorAll('[data-job]').forEach(el=>el.addEventListener('click',()=>{selected=el.dataset.job;if(filter!=='all'&&current()?.status!==filter)filter='all';tab='letter';navigate('applications');}));
  const tabs=[...document.querySelectorAll('[data-tab]')];
  tabs.forEach((el,index)=>{
    el.addEventListener('click',()=>{
      tab=el.dataset.tab;
      render();
      document.querySelector(`#tab-${tab}`).focus();
    });
    el.addEventListener('keydown',event=>{
      const moves={ArrowLeft:(index+tabs.length-1)%tabs.length,ArrowRight:(index+1)%tabs.length,Home:0,End:tabs.length-1};
      if(!(event.key in moves))return;
      event.preventDefault();
      tabs[moves[event.key]].click();
    });
  });
  document.querySelector('#load-demo')?.addEventListener('click',()=>{
    if(lastDocument('cv')) return navigate('applications');
    action(async()=>{
      await api('/demo/seed',{});
      page='applications';
      notify('Fiktiver Lebenslauf und Profil sind bereit.');
    });
  });
  document.querySelector('#profile-form')?.addEventListener('submit',event=>{event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget));action(async()=>{await api('/profile',body);notify('Profil gespeichert.');});});
  document.querySelector('.template-alternative')?.addEventListener('toggle',event=>{templateHelpOpen=event.currentTarget.open;});
  document.querySelector('#template-guide')?.addEventListener('submit',event=>{event.preventDefault();const f=new FormData(event.currentTarget);const text=`Gewünschter Ton: ${f.get('tone')}.\n\nBelegtes Arbeitsbeispiel\n${f.get('experience')}\n\nMotivation\n${f.get('motivation')}\n\nAufbau der individuellen Anschreiben\nMit einer konkreten, passenden Aufgabe beginnen. Relevante Qualifikation früh nennen. Ein bis zwei belegte Beispiele verwenden, auf die Aufgaben der Anzeige eingehen und mit einem kurzen Gesprächswunsch schließen.\n\nAbschluss\nIch freue mich auf ein persönliches Gespräch.`;action(async()=>{await api('/template',{text});notify('Hinweise für künftige Anschreiben gespeichert.');});});
  document.querySelector('#template-form')?.addEventListener('submit',event=>{event.preventDefault();const text=new FormData(event.currentTarget).get('text');action(async()=>{await api('/template',{text});notify('Vorlage gespeichert.');});});
  document.querySelector('#remove-sample')?.addEventListener('click',()=>action(async()=>{
    await api('/template/sample',{},'DELETE');
    notify('Muster entfernt.');
  }));
  document.querySelector('#export-overview')?.addEventListener('click',exportOverview);
  document.querySelector('#check-providers')?.addEventListener('click',checkProviders);
  document.querySelector('#codex-install')?.addEventListener('click',event=>{
    const button=event.currentTarget;
    action(async()=>{
      button.textContent='Codex wird installiert…';
      try {
        await api('/providers/codex/install',{});
        await checkProviders();
        notify('Codex installiert. Melde dich mit deinem ChatGPT-Konto an.');
      } finally { button.textContent='Codex installieren'; }
    });
  });
  document.querySelector('#codex-login')?.addEventListener('click',()=>action(async()=>{
    await api('/providers/codex/login',{});
    notify('Schließe die Anmeldung bei ChatGPT ab und prüfe danach den Status.');
  }));
  document.querySelectorAll('[data-provider]').forEach(button=>button.addEventListener('click',()=>action(async()=>{
    await api('/provider',{provider:button.dataset.provider});
    page='documents';
  })));
  for(const id of ['search-form','direct-search-form']) document.getElementById(id)?.addEventListener('submit',event=>{
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const direct=id==='direct-search-form';
    if(direct) search={...search,url:String(form.get('url')||'').trim()};
    else search={...search,query:String(form.get('query')||''),place:String(form.get('place')||''),boards:String(form.get('boards')||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean)};
    action(async()=>{
      const {query,place,boards,url}=search;
      if(!direct&&boards.length>5) throw new Error('Bitte füge höchstens fünf Firmenportale hinzu.');
      notify('Stellen werden gesucht…');
      let searchError='';
      let result={listings:[]};
      try {result=await api('/search',direct?{url}:{query,place,boards});}
      catch(error) {if(direct||!live()) throw error; searchError=error.message;}
      listings=result.listings;
      searchSources=result.sources||null;
      let researchError=searchError?' '+searchError:'';
      if(!direct&&live()) {
        try {
          const task=await api('/research',{place,query});
          webTask=task.id;
          sessionStorage.setItem('research-task',task.id);
        } catch(error) {researchError+=' Firmensuche im Projektchat: '+error.message;}
      }
      searched=true;
      searchExpanded=true;
      notify(`${listings.length} ${listings.length===1?'Stelle':'Stellen'} gefunden.${researchError}`);
    });
  });
  document.querySelectorAll('.prepare').forEach(button=>button.addEventListener('click',()=>openPreparation(Number(button.dataset.index))));
  document.querySelector('#web-research')?.addEventListener('click',()=>action(async()=>{
    search.place=document.querySelector('#search-form [name=place]').value.trim();
    const task=await api('/research',{place:search.place,query:document.querySelector('#search-form [name=query]').value.trim()});
    webTask=task.id; sessionStorage.setItem('research-task',task.id); searchExpanded=true;
    notify('Recherche gestartet für '+task.topics.join(', ')+'.');
  }));
  document.querySelector('#status-filter')?.addEventListener('change',event=>{filter=event.target.value;render();});
  for(const id of editForms) {
    const form=document.getElementById(id);
    form?.addEventListener('input',()=>markEdits(current(),form));
  }
  document.querySelector('#letter-form')?.addEventListener('submit',event=>{event.preventDefault();const job=current();const letter=new FormData(event.currentTarget).get('letter');action(async()=>{await api(`/jobs/${job.id}/letter`,{revision:job.revision,letter});if(edits(job)['letter-form']?.letter===letter) delete edits(job)['letter-form'];notify('Neue Fassung und PDF gespeichert.');});});
  document.querySelector('#answers-form')?.addEventListener('submit',event=>{event.preventDefault();const job=current();const f=new FormData(event.currentTarget);const body={revision:job.revision,employer:job.employer,title:job.title,target:job.target,letter:job.letter,attachments:job.attachments,answers:job.answers.map(a=>({...a,value:String(f.get(a.key)||'')}))};action(async()=>{await api(`/jobs/${job.id}`,body,'PUT');if(body.answers.every(answer=>edits(job)['answers-form']?.[answer.key]===answer.value)) delete edits(job)['answers-form'];notify('Antworten gespeichert. Bitte diese Fassung prüfen.');});});
  document.querySelector('#open-review')?.addEventListener('click',async()=>{
    if(dialog.open || busy)return;
    busy=true;
    try { await openReview(); }
    catch(error) { notify(error.message,true); }
    finally { busy=false; }
  });
  document.querySelector('#send')?.addEventListener('click',()=>action(async()=>{const job=current();if(job.portal==='JOIN')notify('Falls JOIN eine Anmeldung verlangt, öffne den Anmeldelink im Versandbrowser und kehre dort zur Stelle zurück.');const pending=api(`/jobs/${job.id}/send`,{});job.status='sending';render();try { await pending; } catch(error) { await refresh(); throw error; } notify('Der Versandstand wurde aktualisiert.');}));
  for(const [id,kind] of [['cv-file','cv'],['sample-file','sample']])document.querySelector(`#${id}`)?.addEventListener('change',event=>{
    const file=event.target.files[0];
    if(!file)return;
    const errorBox=kind==='sample'?document.querySelector('#sample-error'):null;
    event.target.value='';
    if(errorBox) errorBox.hidden=true;
    action(async()=>{
      if(file.size>8*1024*1024)throw new Error('Bitte eine PDF bis 8 MB wählen.');
      const bytes=new Uint8Array(await file.arrayBuffer());
      let binary='';
      for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      await api('/documents',{name:file.name,kind,base64:btoa(binary)});
      if(kind==='sample') templateHelpOpen=false;
      if(kind==='cv' && page==='overview') page='documents';
      notify(kind==='sample'?'Musteranschreiben als aktive Vorlage gespeichert.':'PDF lokal gespeichert.');
    },message=>{
      if(!errorBox?.isConnected) return notify(message,true);
      errorBox.textContent=message;
      errorBox.hidden=false;
    });
  });
}
async function openReview(){
  const job=current();const review=await get(`/jobs/${job.id}/review`);
  if(page!=='applications'||current()?.id!==job.id||Object.keys(edits(job)).length) return;
  if(review.revision!==job.revision) {
    await refresh();
    throw new Error('Die Fassung wurde geändert. Prüfe die aktualisierte Bewerbung.');
  }
  const acceptsTerms=job.answers.some(a=>a.type==='application-consent'&&a.value==='Ja');
  dialog.innerHTML=`<button class="dialog-close" aria-label="Prüfung schließen">×</button><h2 id="review-title">Diese Bewerbung freigeben?</h2><p class="muted">Die Freigabe gilt für diese konkrete Fassung.</p><div class="approval-summary"><strong>${esc(job.employer)}</strong><h3>${esc(job.title)}</h3><a href="${esc(job.applyTarget||job.target)}" target="_blank" rel="noopener">${esc(job.applyTarget||job.target)}</a><p>Fassung ${job.revision} · ${job.attachments.length} Anlagen</p></div><h3>Vorgesehene Antworten</h3><dl class="answer-summary">${job.answers.map(answerSummary).join('')}</dl><h3>Vorgesehene Anlagen</h3>${job.attachments.map(id=>{const d=state.documents.find(d=>d.id===id);return `<a class="review-document" href="/api/documents/${id}" target="_blank" rel="noopener">${esc(d.name)} ↗</a>`;}).join('')}<details><summary>Anschreiben vollständig lesen</summary><div class="letter-read">${esc(job.letter)}</div></details>${review.missing.length?`<p class="notice warning">Pflichtangaben fehlen. ${review.missing.map(esc).join(', ')}</p>`:''}<form id="approve-form"><label class="consent"><input type="checkbox" required name="acknowledged">Ich habe Arbeitgeber, konkrete Stelle, Zielportal, alle Antworten und Unterlagen geprüft. ${acceptsTerms?'Ich beauftrage die App, die oben aufgeführten Pflichtbedingungen im Portal zu akzeptieren. ':''}Ich gebe diese Fassung zum Versand frei.</label><div class="notice warning" id="approve-error" role="alert" hidden></div><div class="dialog-actions"><button class="button secondary" type="button" id="cancel-approve">Weiter prüfen</button><button class="button primary" ${review.missing.length?'disabled':''}>Diese Fassung freigeben</button></div></form>`;
  dialog.querySelector('.dialog-close').onclick=()=>dialog.close();dialog.querySelector('#cancel-approve').onclick=()=>dialog.close();
  dialog.querySelector('#approve-form').onsubmit=async event=>{
    event.preventDefault();
    const submit=event.submitter;
    const errorBox=dialog.querySelector('#approve-error');
    submit.disabled=true;
    errorBox.hidden=true;
    try {
      await api(`/jobs/${job.id}/approve`,{hash:review.hash,revision:review.revision,acknowledged:true});
      dialog.close();
      await refresh();
      document.querySelector('#send')?.focus();
      notify('Diese Fassung ist freigegeben. Du kannst den Versand jetzt starten.');
    } catch(error) {
      errorBox.textContent=error.message;
      errorBox.hidden=false;
    } finally { submit.disabled=false; }
  };
  dialog.showModal();
}
setInterval(async()=>{if(state?.jobs.some(j=>j.status==='sending')&&!busy)try { await refresh(); } catch(error) { notify(error.message,true); }},2000);
refresh().then(()=>{if(page==='connection'&&live())return checkProviders();}).catch(error=>{app.innerHTML=`<main id="main" class="loading"><h1>Anwendung gerade nicht erreichbar</h1><p>${esc(error.message)}</p><p>Bitte die lokale Anwendung starten und neu laden.</p></main>`;});
