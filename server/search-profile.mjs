import { z } from 'zod';

const optionalNumber=(max)=>z.string().regex(/^(?:[1-9]\d*(?:\.\d{1,2})?)?$/).refine(s=>!s||Number(s)<=max);
export const preferencesSchema=z.object({
  start:z.union([z.literal(''),z.string().date()]),notice:z.string().trim().max(200),
  salary:optionalNumber(10000000),minimum:optionalNumber(10000000),hours:optionalNumber(100),
  occupation:z.string().trim().max(90).regex(/^[\p{L}\p{M} ()/\-]*$/u).optional(),
  place:z.string().trim().max(160),workplace:z.enum(['','Hybrid','Remote','Vor Ort'])
}).strict();

export function extractContacts(text) {
  const emails=[...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[])];
  const email=emails.length===1?emails[0]:'';
  const lines=text.split(/\n/).map(s=>s.trim()).filter(Boolean).slice(0,16);
  const labeled=lines.find(s=>/^(?:vollständiger name|full name|name)\s*:/i.test(s));
  const plausible=s=>s.length<=100 && /^[\p{Lu}][\p{L}'’-]*(?:\s+(?:(?:van|von|de|del|der|zu|al)\s+)*[\p{Lu}][\p{L}'’-]*){1,4}$/u.test(s)&&
    !/lebenslauf|curriculum|vitae|resume|résumé|engineer|ingenieur|profil|beruf|adresse|techniker|bewerbung|universit|hochschule|studium|manager|contact|gmbh|consultant|developer|software|sales|gehalt|seite|page/i.test(s);
  const name=labeled?.replace(/^[^:]+:\s*/,'')||'';
  if(plausible(name)) return {name,email};
  const given=lines.find(s=>/^(vorname|first name)\s*:/i.test(s))?.replace(/^[^:]+:\s*/, '');
  const family=lines.find(s=>/^(nachname|last name)\s*:/i.test(s))?.replace(/^[^:]+:\s*/, '');
  if(given&&family&&plausible(given+' '+family)) return {name:given+' '+family,email};
  const normalize=s=>s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu,'').replace(/[^a-z]/g,'');
  const mailbox=normalize(email.split('@')[0]);
  const candidates=lines.filter(plausible).filter(s=>{
    const parts=s.split(/\s+/).map(normalize);
    return parts[0].length>=2&&parts.at(-1).length>=2&&mailbox.includes(parts[0])&&mailbox.includes(parts.at(-1));
  });
  return {name:candidates.length===1?candidates[0]:'',email};
}

export function preferenceAnswer(field,prefs={}) {
  const label=field.label.trim().replace(/\s*[*:]\s*$/,'').toLowerCase();
  if(/^(kündigungsfrist|notice period)( in wochen| in weeks)?$/.test(label)) {
    if(/ in (wochen|weeks)$/.test(label)) return prefs.notice?.match(/^(\d+)\s*(?:wochen|weeks)$/i)?.[1];
    return prefs.notice;
  }
  if(/^(frühest(?:er|möglicher) (?:eintrittstermin|starttermin|arbeitsbeginn)|eintrittsdatum|verfügbar ab|available from|earliest start date|start date)$/.test(label)) return prefs.start;
  if(/^(gehaltsvorstellung|gehaltswunsch|salary expectations?)(?:\s*\(?(?:brutto\/jahr|brutto pro jahr|eur brutto\/jahr|annual gross eur|eur per year)\)?)?$/.test(label)&&prefs.salary)
    return field.type==='number'?(/jahr|annual|year/.test(label)?prefs.salary:undefined):prefs.salary+' EUR brutto/Jahr';
  if(/^(gewünschte wochenstunden|desired weekly hours)$/.test(label)) return prefs.hours;
}

export function checkPreferences(listings,prefs) {
  return listings.flatMap(job=>{
    const margin=[];
    const content=job.title+' '+job.description;
    // Only compare explicitly advertised annual EUR ranges. Hourly pay, forecasts and benefits are not comparable.
    const annual=content.match(/(?:gehalt|vergütung|jahresbruttogehalt|jahresgehalt|salary)\s*[:(]?\s*(\d{2,3}(?:[., ]\d{3})|\d{4,6})\s*(?:€|EUR)?\s*(?:bis|to|[–-])\s*(\d{2,3}(?:[., ]\d{3})|\d{4,6})\s*(?:€|EUR)\s*(?:brutto\s*)?(?:pro jahr|jährlich|p\.?\s*a\.?|\/jahr|per year|annually)/i);
    if(prefs.minimum){
      if(annual&&Number(annual[2].replace(/\D/g,''))<Number(prefs.minimum))return [];
      margin.push(annual?'Gehaltsband überschneidet sich mit deiner Untergrenze':'Gehaltsuntergrenze noch zu klären');
    }
    let preferenceScore=0;
    if(prefs.hours) {
      const hours=content.match(/\b(\d{1,2})(?:[,.]5)?\s*(?:stunden|std\.?|hours)\s*(?:pro woche|je woche|\/\s*woche|per week|a week)/i);
      const exact=hours&&Number(hours[0].match(/^\d+(?:[,.]5)?/)[0].replace(',','.'))===Number(prefs.hours);
      margin.push(exact?'Wochenstunden passen':hours?'Wochenstunden abgleichen':'Wochenstunden noch zu klären');
      if(exact) preferenceScore+=1;
    }
    if(prefs.workplace) {
      const label=job.location+' '+job.title;
      const described=/\bhybrid\b/i.test(label)?'Hybrid':/\bremote\b|homeoffice/i.test(label)?'Remote':/vor ort|on[ -]site/i.test(label)?'Vor Ort':'';
      margin.push(described?'Arbeitsmodell laut Anzeige: '+described:'Arbeitsmodell noch zu klären');
      if(described===prefs.workplace) preferenceScore+=2;
    }
    return [{...job,preferenceNotes:margin,preferenceScore}];
  });
}
