import { z } from 'zod';

// Web research supplies links for a human to open. The server never fetches these URLs.
export const webResults=z.array(z.object({
  target:z.string().max(2000).url().refine(raw=>{
    const u=new URL(raw);
    return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)&&
      !/\.(local|internal|localhost|test|invalid)$/i.test(u.hostname)&&u.pathname.length>1;
  }),
  employer:z.string().trim().min(1).max(200),title:z.string().trim().min(1).max(300),
  location:z.string().max(300),description:z.string().min(60).max(12000),portal:z.string().min(1).max(100)
}).strict()).max(20);

// Public listings only. Every request goes to a fixed publishing host.
async function json(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(9000), redirect: 'error'});
  if (!response.ok) throw new Error('Stellenquelle derzeit nicht erreichbar.');
  return response.json();
}

function listing(host, url, employer, title, location, description, portal) {
  let link;
  try { link = new URL(url); } catch { return []; }
  if (link.protocol !== 'https:' || link.host !== host || link.username || link.password ||
      !title || !employer || !description) return [];
  return [{target: link.href, employer, title, location: location || 'Offen',
    description: description.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim().slice(0,16000), portal}];
}

async function arbeitnow() {
  const feed = await json('https://www.arbeitnow.com/api/job-board-api');
  return feed.data.flatMap(j => listing('www.arbeitnow.com', j.url, j.company_name, j.title,
    [j.location, j.remote && 'Remote'].filter(Boolean).join(' · '), j.description, 'Arbeitnow'));
}
async function ashby(board, company) {
  const feed = await json('https://api.ashbyhq.com/posting-api/job-board/' + board);
  return feed.jobs.filter(j => j.isListed).flatMap(j => listing('jobs.ashbyhq.com', j.jobUrl, company, j.title,
    [j.location,j.workplaceType].filter(Boolean).join(' · '), j.descriptionPlain, 'Ashby'));
}
async function lever(board, company) {
  const feed = await json('https://api.lever.co/v0/postings/' + board + '?mode=json&limit=100');
  return feed.flatMap(j => listing('jobs.lever.co', j.hostedUrl, company, j.text,
    [j.categories?.location,j.workplaceType].filter(Boolean).join(' · '),
    [j.descriptionPlain,...(j.lists || []).map(item => item.content)].filter(Boolean).join(' '), 'Lever'));
}

export const publicFeeds = [arbeitnow, () => ashby('linear','Linear'), () => ashby('deepl','DeepL'),
  () => lever('spotify','Spotify'), () => ashby('pleo','Pleo')];
