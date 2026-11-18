import { checkPreferences } from './search-profile.mjs';
import { companySources } from './company-search.mjs';
import { z } from 'zod';
import { publicFeeds } from './discovery.mjs';

export const sourceSchema = z.object({ employer: z.string().min(2).max(120), board: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), region: z.enum(['global','eu']) });
const clean = html => html.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
async function boardRequest(region,path,timeout=8000) {
  const request=host=>fetch(`https://${host}/v1/boards/${path}`,{signal:AbortSignal.timeout(timeout),redirect:'error'});
  let global;
  try { global=await request('boards-api.greenhouse.io'); }
  catch(error) { if(region!=='eu') throw error; }
  if(global?.ok||region!=='eu') return global;
  return request('boards-api.eu.greenhouse.io');
}
export const jobTarget = ({region,board,jobId}) => `https://${region === 'eu' ? 'job-boards.eu.greenhouse.io' : 'job-boards.greenhouse.io'}/${board}/jobs/${jobId}`;
const boardHosts=['job-boards.greenhouse.io','job-boards.eu.greenhouse.io','boards.greenhouse.io','boards.eu.greenhouse.io'];
const starterBoards=[
  ['Agile Robots','agilerobotsse','eu'],['Staffbase','staffbase','global'],
  ['commercetools','commercetools','global'],['Contentful','contentful','global'],
  ['Raisin','raisin','eu'],['Bitpanda','bitpanda','eu'],
  ['Hive','hive','eu'],['Wellhub','gympass','global']
].map(([employer,board,region])=>({employer,board,region}));

function publicBoardUrl(value) {
  try {
    const url=new URL(value);
    if(url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&boardHosts.includes(url.hostname)) return url;
  } catch {}
  return null;
}

export function parseJobLink(value) {
  const error = 'Füge den direkten Link zur Stelle im Greenhouse-Portal ein. Andere Portale kannst du über die Karriereseite der Firma nutzen.';
  const url=publicBoardUrl(value);
  const match=url?.pathname.match(/^\/([a-zA-Z0-9_-]{1,80})\/jobs\/(\d{1,20})\/?$/);
  if(!match) throw new Error(error);
  return {board:match[1],jobId:match[2],region:url.hostname.includes('.eu.')?'eu':'global'};
}

function extraBoard(value) {
  const url=publicBoardUrl(value);
  const match=url?.pathname.match(/^\/([a-zA-Z0-9_-]{1,80})\/?$/);
  if(!match) throw new Error('Füge einen direkten Greenhouse-Firmenlink ein, etwa https://job-boards.greenhouse.io/firma.');
  return {board:match[1],region:url.hostname.includes('.eu.')?'eu':'global'};
}

const normalize=text=>text.toLowerCase().normalize('NFKD').replace(/\p{Mark}/gu,'').replace(/ß/g,'ss');
const stop=new Set('able about alle also auch auf aus based benefits bieten both business company das daten den der deutsch deutschland dich die ein eine einen einer einem einer english englisch experience flexible for from good have ihr ihre ihnen inklusive into jahre knowledge konnt learn letter management more munich munchen oder our people plenty position role skills start strong support team the their this teil that und unser unsere unter various will with work years year you your zusammen sowie eine mehr emea germany europe looking responsible contribute innerhalb lebenslauf bewerbung resume curriculum vitae profil berufserfahrung ausbildung kontakt adresse vorname nachname deutschland erfahrung arbeiten arbeit kenntnisse gute guten excellent senior junior lead manager engineer ingenieur engineering mitarbeiter specialist specialistin specialistin gmbh international fachlich beruflich sowie bewerben gerne unternehmen verantwortlich verantwortung entwicklung beruf ausbildungskandidat city street email phone gmail outlook'.split(' '));
const words=text=>new Set((normalize(text).match(/[a-z0-9][a-z0-9+-]{2,}/g)||[]).filter(word=>!stop.has(word)&&/[a-z]/.test(word)));
const specialties=[
  ['Prüftechnik',/\b(hil|sil|test\w*|versuch\w*|pruf\w*|validier\w*|validation|verification|vvt|qa)\b/],
  ['Messtechnik',/\b(sensor\w*|messtech\w*|messdat\w*|messreih\w*|measurement\w*|instrumentation)\b/],
  ['Elektrotechnik',/\b(elektr\w*|electr\w*|circuit\w*|mechatron\w*|hardware\w*|pcb|schaltplan\w*)\b/],
  ['Automatisierung',/\b(automat\w*|robot\w*|sps|plc|scada)\b/],
  ['Konstruktion',/\b(konstrukt\w*|prototyp\w*|mechanic\w*|mechanik\w*|cad|catia|solidworks)\b/],
  ['Software',/\b(software|embedded|backend|frontend|typescript|python|java|javascript|golang)\b/],
  ['Vertrieb',/\b(vertrieb\w*|sales|account executive|account management|lead generation|crm)\b/],
  ['Beratung',/\b(consult\w*|beratung\w*|customer success|kundenberat\w*)\b/],
  ['Personal',/\b(recruit\w*|talent acquisition|personalwesen|people operations|hris)\b/],
  ['Finanzen',/\b(financ\w*|finanz\w*|accounting|buchhalt\w*|treasury|controlling)\b/],
  ['Logistik',/\b(logisti\w*|warehous\w*|lagerlogist\w*|supply chain|fulfil\w*)\b/],
  ['Marketing',/\b(marketing|campaign\w*|kampagn\w*|seo|sem|brand)\b/],
  ['Pflege',/\b(pflege\w*|krankenpfleg\w*|nursing|nurse)\b/],
  ['Pädagogik',/\b(padagog\w*|erzieh\w*|lehrkraft|teacher|teaching)\b/],
  ['Handwerk',/\b(tischler\w*|schreiner\w*|carpentry|handwerk\w*)\b/],
  ['Gastronomie',/\b(koch|kochin|gastro\w*|restaurant\w*|hospitality)\b/],
  ['Design',/\b(design\w*|gestaltung|ux|typograf\w*|typograph\w*)\b/],
  ['Gesundheitswesen',/\b(medizin\w*|physiotherap\w*|ergotherap\w*|apothek\w*|clinical|pharmac\w*)\b/],
  ['Recht',/\b(jurist\w*|rechtsanw\w*|legal|paralegal|rechtsfach\w*)\b/],
  ['Wissenschaft',/\b(labor\w*|biolog\w*|chemie\w*|chemiker\w*|physik\w*|scientist)\b/],
  ['Bauwesen',/\b(bauleit\w*|hochbau\w*|tiefbau\w*|architekt\w*|civil engineering)\b/],
  ['Einzelhandel',/\b(einzelhandel\w*|kassier\w*|retail|verkauf\w*)\b/],
  ['Verwaltung',/\b(verwaltung\w*|sachbearbeit\w*|burokauf\w*|administration)\b/]
];
const locationNames={munich:['munich','munchen','muenchen'],munchen:['munich','munchen','muenchen'],muenchen:['munich','munchen','muenchen'],cologne:['cologne','koln','koeln'],koln:['cologne','koln','koeln'],germany:['germany','deutschland'],deutschland:['germany','deutschland']};

async function boardListings(board) {
  const requests=[boardRequest(board.region,`${board.board}/jobs?content=true`)];
  if(!board.employer) requests.push(boardRequest(board.region,board.board));
  const [response,company]=await Promise.all(requests);
  if(!response.ok||(company&&!company.ok)) throw new Error('Firmenportal nicht erreichbar.');
  const {jobs}=await response.json();
  const employer=board.employer||(await company.json()).name;
  const source=sourceSchema.parse({...board,employer});
  return jobs.slice(0,800).filter(job=>/^\d{1,20}$/.test(String(job.id))&&typeof job.title==='string'&&!/talent (community|pool|network)|open application|initiativbewerbung|speculative application/i.test(job.title)).map(job=>{
    const post={...source,jobId:String(job.id)};
    return {source:post,employer,title:job.title.slice(0,300),location:String(job.location?.name||'Offen').slice(0,300),description:clean(String(job.content||'').slice(0,32000)),target:jobTarget(post)};
  });
}

export function searchTopics(cvText) {
  return specialties.filter(([,pattern])=>pattern.test(normalize(cvText))).map(([label])=>label);
}

export async function findJobMatches({cvText,query='',place='',boards=[],existing=[],preferences={}}) {
  if (!cvText?.trim()) throw new Error('Hinterlege zuerst einen lesbaren Lebenslauf.');
  const unique=new Map(starterBoards.map(board=>[`${board.region}:${board.board}`,board]));
  for(const url of boards) {
    const board=extraBoard(url);
    const key=`${board.region}:${board.board}`;
    if(!unique.has(key)) unique.set(key,board);
  }
  const feeds=[...publicFeeds,...companySources(searchTopics(cvText))];
  const results=await Promise.allSettled([...Array.from(unique.values(),boardListings),...feeds.map(load=>load())]);
  const reached=results.filter(result=>result.status==='fulfilled');
  if(!reached.length) throw new Error('Die Stellenportale sind gerade nicht erreichbar. Versuche die Suche später erneut oder füge eine konkrete Anzeige ein.');
  const candidates=reached.flatMap(result=>result.value);
  return {listings:matchListings(checkPreferences(candidates,preferences),{cvText,query,place,existing}),sources:{checked:reached.length,total:results.length}};
}

export function matchListings(candidates,{cvText,query='',place='',existing=[]}) {
  if (!cvText?.trim()) return [];
  const previous=new Set(existing);
  const locations=normalize(place).split(/[,;]/).map(name=>name.trim()).filter(Boolean).flatMap(name=>locationNames[name]||[name]);
  const cv=normalize(cvText);
  const profileWords=words(cv);
  const relevant=specialties.filter(([,pattern])=>pattern.test(cv));
  const queryWords=words(query);
  const querySpecialties=specialties.filter(([,pattern])=>pattern.test(normalize(query)));
  const matches=[];
  for(const job of candidates) {
    if(previous.has(job.target)) continue;
    if(locations.length&&!locations.some(place=>normalize(job.location).includes(place)||(['remote','homeoffice','home office'].includes(place)&&/\b(remote|home office|homeoffice)\b/i.test(job.location)))) continue;
    const name=normalize(job.title);
    const full=`${name} ${normalize(job.description)}`;
    const titleWords=words(name);
    const postingWords=words(full);
    const commonWords=[...postingWords].filter(word=>profileWords.has(word));
    const commonSpecialties=relevant.filter(([,pattern])=>pattern.test(full));
    const queryHits=[...queryWords].filter(word=>postingWords.has(word)).length;
    if(queryWords.size&&!queryHits&&!querySpecialties.some(([,pattern])=>pattern.test(full))) continue;
    const titleHits=commonSpecialties.filter(([,pattern])=>pattern.test(name)).length;
    const keywords=commonWords.filter(word=>titleWords.has(word));
    if(!titleHits && !keywords.length && commonSpecialties.length<2) continue;
    const score=(job.preferenceScore||0)+titleHits*8+keywords.length*5+commonSpecialties.length*4+Math.min(commonWords.length,10)+queryHits*3;
    const matchesProfile=[...new Set([...commonSpecialties.map(([,pattern])=>cv.match(pattern)[0]),...keywords])].slice(0,5);
    matches.push({score,list:({...job,matchesProfile})});
    previous.add(job.target);
  }
  return matches.sort((a,b)=>b.score-a.score).slice(0,20).map(match=>match.list);
}

export async function officialListing(source) {
  const {board,region,jobId}=source;
  const [res,details]=await Promise.all([
    boardRequest(region,board,10000),
    greenhouseFields(source)
  ]);
  if(!res.ok) throw new Error('Das offizielle Stellenportal konnte nicht gelesen werden.');
  const {name}=await res.json();
  const confirmed=sourceSchema.parse({employer:name,board,region});
  const listing={employer:confirmed.employer,title:details.title,location:details.location,description:details.description,source:{...confirmed,jobId},target:jobTarget(source)};
  return {listing,details};
}

export async function greenhouseFields(source) {
  const response = await boardRequest(source.region,`${source.board}/jobs/${source.jobId}?questions=true`,10000);
  if (!response.ok) throw new Error('Die Stelle oder das öffentliche Formular ist nicht verfügbar.');
  const job = await response.json();
  const fields = [];
  for (const question of job.questions || []) {
    const field = question.fields?.[0];
    if (!field || ['resume','cover_letter'].includes(field.name)) continue;
    if (!['input_text','textarea','multi_value_single_select'].includes(field.type)) {
      if (question.required) throw new Error(`Dieses Pflichtfeld benötigt manuelle Vorbereitung: ${question.label}`);
      continue;
    }
    fields.push({ key: field.name, label: question.label.trim(), type: field.type, required: question.required, options: (field.values || []).map(v => v.label), value: '' });
  }
  return { fields, title: job.title, location: job.location?.name || 'Offen', description: clean(job.content || ''), hasCoverLetter: (job.questions || []).some(q => q.fields?.[0]?.name === 'cover_letter') };
}
