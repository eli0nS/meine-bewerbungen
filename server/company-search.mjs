// The employer receives a public occupational keyword, never text from a CV.
const keywords={Prüftechnik:'Test',Messtechnik:'Measurement',Elektrotechnik:'Electrical',
  Automatisierung:'Automation',Konstruktion:'Design',Software:'Software',Vertrieb:'Sales',Beratung:'Consulting',
  Personal:'Recruiting',Finanzen:'Finance',Logistik:'Logistics',Marketing:'Marketing',Pflege:'Nursing',
  Pädagogik:'Education',Handwerk:'Technik',Gastronomie:'Gastronomie',Design:'Design',Verwaltung:'Administration',Gesundheitswesen:'Medizin',Recht:'Legal',Wissenschaft:'Labor',Bauwesen:'Bau',Einzelhandel:'Verkauf'};
const text=html=>String(html||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
const timeout=()=>AbortSignal.timeout(8500);

async function rss(host,employer,word) {
  const url=new URL('/services/rss/job/', 'https://'+host);
  url.search=new URLSearchParams({locale:'de_DE',keywords:word});
  const res=await fetch(url,{redirect:'error',signal:timeout()});
  if(!res.ok) throw new Error('Firmenfeed nicht erreichbar.');
  const xml=await res.text();
  if(!/<rss\b/i.test(xml)) throw new Error('Firmenfeed nicht verfügbar.');
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap(([,item])=>{
    const get=tag=>(item.match(new RegExp('<'+tag+'>([\\s\\S]*?)</'+tag+'>'))?.[1]||'').replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/,'$1');
    let url;try{url=new URL(get('link').replace(/&amp;/g,'&'));}catch{return [];}
    if(url.origin!=='https://'+host||!url.pathname.startsWith('/job/'))return [];
    url.search='';url.hash='';
    const full=text(get('title')),location=full.match(/\s+\(([^()]+)\)$/);
    const description=text(get('description')).slice(0,16000);
    return description?[{employer,title:full.slice(0,location?.index??full.length),location:location?.[1]||'',description,target:url.href,portal:'Firmenkarriere'}]:[];
  });
}
async function airbus(word) {
  const host='https://ag.wd3.myworkdayjobs.com';
  const api=host+'/wday/cxs/ag/Airbus';
  const res=await fetch(api+'/jobs',{method:'POST',redirect:'error',signal:timeout(),headers:{'Content-Type':'application/json',Accept:'application/json'},
    body:JSON.stringify({appliedFacets:{},limit:8,offset:0,searchText:word})});
  if(!res.ok)throw new Error('Airbus-Stellensuche nicht erreichbar.');
  const {jobPostings}=await res.json();
  return details(jobPostings,async j=>{
    if(!/^\/job\/[\w%./-]+$/.test(j.externalPath)||j.externalPath.includes('..'))return null;
    const r=await fetch(api+j.externalPath,{redirect:'error',signal:timeout()});
    if(!r.ok)return null;
    const {jobPostingInfo:info}=await r.json();
    return {employer:'Airbus',title:info.title,description:text(info.jobDescription),location:info.location,target:host+'/Airbus'+j.externalPath,portal:'Workday'};
  });
}
async function details(records,read) {
  const results=await Promise.allSettled(records.map(read));
  const hits=results.flatMap(r=>r.status==='fulfilled'&&r.value?.description?[r.value]:[]);
  if(records.length&&!hits.length) throw new Error('Einzelanzeigen nicht verfügbar.');
  return hits;
}
async function smartRecruiters(board,word) {
  const api='https://api.smartrecruiters.com/v1/companies/'+board+'/postings';
  const res=await fetch(api+'?limit=8&q='+encodeURIComponent(word),{redirect:'error',signal:timeout()});
  if(!res.ok)throw new Error('Firmenportal nicht erreichbar.');
  const {content}=await res.json();
  return details(content,async j=>{
    if(!/^\d+$/.test(j.id))return null;
    const r=await fetch(api+'/'+j.id,{redirect:'error',signal:timeout()});
    if(!r.ok)return null;
    const d=await r.json(),url=new URL(d.postingUrl);
    if(url.origin!=='https://jobs.smartrecruiters.com'||!url.pathname.toLowerCase().startsWith('/'+board.toLowerCase()+'/'))return null;
    return {employer:d.company.name,title:d.name,location:d.location.fullLocation||d.location.city,
      description:text([d.jobAd.sections.jobDescription?.text,d.jobAd.sections.qualifications?.text].join(' ')).slice(0,16000),target:url.href,portal:'SmartRecruiters'};
  });
}
export function companySources(topics) {
  const word=keywords[topics[0]]||'';
  return [
    ...[['jobs.bmwgroup.com','BMW Group'],['jobs.man.eu','MAN Truck & Bus'],['careers.sap.com','SAP'],['jobs.zf.com','ZF'],['jobs.schaeffler.com','Schaeffler']].map(([host,name])=>()=>rss(host,name,word)),
    ()=>airbus(word),()=>smartRecruiters('BoschGroup',word)
  ];
}
