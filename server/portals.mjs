import { hostedPortal, submitHosted, hostedStep, contactFields } from './hosted-portals.mjs';
import { inspectCheckboxes, checkboxBlocked, checkboxReview } from './portal-checkboxes.mjs';
import { chromium } from 'playwright';
import { jobTarget } from './search.mjs';
import { digest } from './store.mjs';

export function validateTarget(job, mode, base) {
  const target = new URL(job.target);
  if(mode==='live' && ['external','hosted'].includes(job.source.region)) {
    if(target.protocol!=='https:' || target.username || target.password || digest(target.href).slice(0,32)!==job.source.jobId)
      throw new Error('Das Ziel weicht von der gefundenen Anzeige ab.');
    if(job.source.region==='hosted' && (!job.applyTarget||hostedPortal(target.href)?.apply!==job.applyTarget)) throw new Error('Das freigegebene Formular stimmt nicht mit der Anzeige überein.');
    return target;
  }
  if (target.username || target.password || target.hash || target.search) throw new Error('Ungültiges Portalziel.');
  if (mode === 'demo') {
    if (target.origin !== base || target.pathname !== `/test-portal/${job.id}`) throw new Error('Im Demomodus ist nur das lokale Testportal erlaubt.');
  } else {
    if (target.href !== jobTarget(job.source)) throw new Error('Das Portal passt nicht zur geprüften Stellenquelle.');
  }
  return target;
}

async function blocker(page) {
  if (await page.locator('input[type="password"]').isVisible().catch(() => false)) return 'Das Portal verlangt eine Anmeldung.';
  if (await page.locator('iframe[title*="challenge" i], iframe[title*="captcha" i], [data-test="captcha"]').first().isVisible().catch(() => false)) return 'Das Portal verlangt eine CAPTCHA-Prüfung.';
  return '';
}

// Inspect publicly served form markup without running its scripts or sending applicant data.
export async function publicFormFields(portal) {
  const contacts=contactFields();
  if(portal.provider==='JOIN') return contacts;
  let browser;
  try {
    const response=await fetch(portal.apply,{redirect:'error',signal:AbortSignal.timeout(7000)});
    if(!response.ok) return contacts;
    const html=await response.text();
    if(html.length>3000000) return contacts;
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({javaScriptEnabled:false,serviceWorkers:'block'});
    await page.route('**/*',route=>route.abort());
    await page.setContent(html,{waitUntil:'domcontentloaded',timeout:5000});
    const markup=await hostedStep(page,{answers:contacts},[],new Set(),true,false,portal.apply);
    return contacts.concat(markup?.fields||[]).slice(0,80);
  } catch {return contacts;} finally {await browser?.close();}
}

export async function deliver({ job, documents, mode, base, headless, fixtureToken, onSubmit, onLogin }) {
  if(job.source.region==='external') throw new Error('Diese Bewerbung reichst du persönlich beim Arbeitgeber ein.');
  const listing = validateTarget(job, mode, base);
  const portal=mode==='live'&&job.source.region==='hosted'?hostedPortal(listing.href):null;
  const target=portal?new URL(portal.apply):listing;
  let browser;
  let attempted = false;
  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({serviceWorkers:'block'});
    let loading = true;
    await context.route('**/*', route => {
      const request=route.request();
      const url=new URL(request.url());
      if(url.origin===target.origin) {
        if(portal) {
          const next=hostedPortal(url.href);
          if(next && next.apply!==portal.apply) return route.abort();
        }
        return route.continue();
      }
      // Before entering any personal data, permit only HTTPS assets for the live form.
      const asset=['script','stylesheet','image','font'].includes(request.resourceType());
      return mode==='live'&&loading&&url.protocol==='https:'&&asset&&request.method()==='GET'?route.continue():route.abort();
    });
    await context.routeWebSocket('**/*',socket=>socket.close());
    const page = await context.newPage();
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if(portal) {
      await page.waitForLoadState('load',{timeout:10000}).catch(()=>{});
      await page.locator('form input:visible,main textarea:visible,input[type=file],input[type=password]:visible').first().waitFor({timeout:10000}).catch(()=>{});
      loading=false;
      return await submitHosted(page,job,documents,{portal,headless,onLogin,onSubmit:async()=>{
        await onSubmit();
        attempted=true;
      }});
    }
    loading=false;
    if (new URL(page.url()).origin !== target.origin || new URL(page.url()).pathname !== target.pathname) throw new Error('Das Portal hat auf ein anderes Ziel umgeleitet.');
    let reason = await blocker(page);
    if (reason) return { status: 'blocked', message: reason };
    const submit = page.getByRole('button', { name: /^(Submit application|Bewerbung absenden|Bewerbung senden)$/i });
    if (await submit.count()!==1||!await submit.isVisible()) return { status: 'blocked', message: 'Die konkrete Absendeaktion wurde nicht eindeutig erkannt.' };
    const form = page.locator('form').filter({has:submit});
    const consentScope = await form.count()===1 ? form : page.locator('main').first();
    const checkboxes = await inspectCheckboxes(consentScope,job.answers,page.url());
    if (checkboxes.message) return checkboxBlocked(checkboxes.message);
    if (checkboxes.fields.length) return checkboxReview(checkboxes.fields);
    for (const answer of job.answers) {
      if (answer.type==='application-consent'||answer.type==='checkbox') continue;
      if (!answer.value.trim()) continue;
      let field = page.locator(`[name="${answer.key}"]`);
      if (!await field.count()) field = page.getByLabel(answer.label, { exact: true });
      if (await field.count()!==1) return { status: 'blocked', message: `Feld „${answer.label}“ ist im Portal nicht eindeutig verfügbar.` };
      const tag = await field.evaluate(el => el.tagName.toLowerCase());
      if (tag === 'select') await field.selectOption({ label: answer.value });
      else if (await field.getAttribute('role') === 'combobox') {
        await field.click();
        await page.getByRole('option', { name: answer.value, exact: true }).click({ timeout: 5000 });
      } else if (['input', 'textarea'].includes(tag)) await field.fill(answer.value);
      else return { status: 'blocked', message: `Feldtyp für „${answer.label}“ erfordert eine manuelle Prüfung.` };
    }
    for (const document of documents) {
      const field = page.locator(`input[type="file"][name="${document.kind === 'cv' ? 'resume' : 'cover_letter'}"], input[type="file"]#${document.kind === 'cv' ? 'resume' : 'cover_letter'}`);
      if (await field.count()!==1) return { status: 'blocked', message: `Der freigegebene Upload für „${document.name}“ ist nicht eindeutig verfügbar.` };
      await field.setInputFiles({ name: document.name, mimeType: 'application/pdf', buffer: Buffer.from(document.bytes) });
    }
    const finalCheckboxes = await inspectCheckboxes(consentScope,job.answers,page.url());
    if (finalCheckboxes.message) return checkboxBlocked(finalCheckboxes.message);
    if (finalCheckboxes.fields.length) return checkboxReview(finalCheckboxes.fields);
    for (const apply of finalCheckboxes.actions) await apply();
    const remaining = await page.locator('input[required], textarea[required], select[required]').evaluateAll(elements => elements.filter(el => !el.checkValidity()).map(el => el.name || el.id));
    if (remaining.length) return { status: 'blocked', message: `Weitere Pflichtfelder sind offen: ${remaining.join(', ')}.` };
    reason = await blocker(page);
    if (reason) return { status: 'blocked', message: reason };
    if (mode === 'demo') await page.locator('[name="delivery_token"]').evaluate((element, token) => { element.value = token; }, fixtureToken);
    const formAction=await submit.evaluate(element=>element.getAttribute('formaction')||element.form?.action||location.href);
    if(new URL(formAction,page.url()).origin!==target.origin) return {status:'blocked',message:'Das Formular verweist auf ein anderes Versandziel.'};
    await onSubmit();
    attempted = true;
    await submit.click();
    await page.waitForFunction(() => {
      const text = document.body.innerText;
      const form = document.querySelector('input[type="file"],input[name="first_name"]');
      return !form && /application has been (received|submitted)|thank you for applying|Bewerbung ist eingegangen|Bewerbung wurde.*übermittelt/i.test(text);
    }, undefined, { timeout: 12000 });
    if (new URL(page.url()).origin !== target.origin) throw new Error('Die Bestätigung stammt nicht vom freigegebenen Portal.');
    return { status: 'sent', message: (await page.locator('body').innerText()).slice(0,1000), confirmationUrl: page.url() };
  } catch (error) {
    return { status: attempted ? 'unknown' : 'blocked', message: attempted ? 'Absendeversuch erfolgt. Eine verlässliche Portalbestätigung fehlt. Bitte den Eingang persönlich prüfen.' : `Portal angehalten. ${error.message.split('\n')[0]}` };
  } finally {
    await browser?.close();
  }
}
