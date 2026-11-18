import { chromium } from 'playwright';
import { jobTarget } from './search.mjs';
import { digest } from './store.mjs';

export function validateTarget(job, mode, base) {
  const target = new URL(job.target);
  if(mode==='live' && job.source.region==='external') {
    if(target.protocol!=='https:' || target.username || target.password || digest(target.href).slice(0,32)!==job.source.jobId)
      throw new Error('Das Ziel weicht von der gefundenen Anzeige ab.');
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

export async function deliver({ job, documents, mode, base, headless, fixtureToken, onSubmit }) {
  if(job.source.region==='external') throw new Error('Diese Bewerbung reichst du persönlich beim Arbeitgeber ein.');
  const target = validateTarget(job, mode, base);
  let browser;
  let attempted = false;
  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({serviceWorkers:'block'});
    let loading = true;
    await context.route('**/*', route => {
      const request=route.request();
      const url=new URL(request.url());
      if(url.origin===target.origin) return route.continue();
      // Before entering any personal data, permit only HTTPS assets for the live form.
      const asset=['script','stylesheet','image','font'].includes(request.resourceType());
      return mode==='live'&&loading&&url.protocol==='https:'&&asset&&request.method()==='GET'?route.continue():route.abort();
    });
    await context.routeWebSocket('**/*',socket=>socket.close());
    const page = await context.newPage();
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    loading=false;
    if (new URL(page.url()).origin !== target.origin || new URL(page.url()).pathname !== target.pathname) throw new Error('Das Portal hat auf ein anderes Ziel umgeleitet.');
    let reason = await blocker(page);
    if (reason) return { status: 'blocked', message: reason };
    for (const answer of job.answers) {
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
    const remaining = await page.locator('input[required], textarea[required], select[required]').evaluateAll(elements => elements.filter(el => !el.checkValidity()).map(el => el.name || el.id));
    if (remaining.length) return { status: 'blocked', message: `Weitere Pflichtfelder sind offen: ${remaining.join(', ')}.` };
    reason = await blocker(page);
    if (reason) return { status: 'blocked', message: reason };
    // Never silently accept newly appearing contracts or consent checkboxes.
    if (await page.locator('input[type="checkbox"]:not(:checked)').count()) return { status: 'blocked', message: 'Das Formular enthält eine gesondert zu prüfende Einwilligung.' };
    if (mode === 'demo') await page.locator('[name="delivery_token"]').evaluate((element, token) => { element.value = token; }, fixtureToken);
    const submit = page.getByRole('button', { name: /^(Submit application|Bewerbung absenden|Bewerbung senden)$/i });
    if (await submit.count()!==1||!await submit.isVisible()) return { status: 'blocked', message: 'Die konkrete Absendeaktion wurde nicht eindeutig erkannt.' };
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
