import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {contactFields,hostedPortal,hostedStep,submitHosted} from '../server/hosted-portals.mjs';
import {extractContacts,preferenceAnswer,checkPreferences} from '../server/search-profile.mjs';
import {makePdf} from '../server/documents.mjs';

test('CV contacts and search constraints stay specific to the applicant',()=>{
  assert.deepEqual(extractContacts('Lebenslauf\nMira Beispiel\nmira.beispiel@example.invalid'),{name:'Mira Beispiel',email:'mira.beispiel@example.invalid'});
  assert.deepEqual(extractContacts('Lebenslauf\nName: Cora Muster\nc@example.invalid\nr@example.invalid'),{name:'Cora Muster',email:''});
  assert.deepEqual(extractContacts('Lebenslauf\nSoftware Engineer\nPostfach'),{name:'',email:''});
  assert.equal(preferenceAnswer({label:'Gehaltsvorstellung',type:'text'},{salary:'65000',minimum:'61000'}),'65000 EUR brutto/Jahr');
  assert.equal(preferenceAnswer({label:'Bisheriges Gehalt',type:'text'},{salary:'65000'}),undefined);
  assert.equal(preferenceAnswer({label:'Gewünschte Wochenstunden'},{hours:'35'}),'35');
  assert.deepEqual(checkPreferences([{title:'Beispiel',description:'Gehalt: 45.000 bis 55.000 EUR brutto pro Jahr'}],{minimum:'61000'}),[]);
  assert.equal(checkPreferences([{title:'Beispiel',description:'Offen'}],{minimum:'61000'}).length,1);
});

const providers=[
  ['Personio','https://beispiel.jobs.personio.de/job/777'],
  ['JOIN','https://join.com/companies/beispiel/777-test'],
  ['Lever','https://jobs.eu.lever.co/beispiel/10101010-1111-1111-1111-101010101010'],
  ['Teamtailor','https://beispiel.teamtailor.com/jobs/777-test']
];
for(const [name,url] of providers) test(name+' fills a fictional application, uploads both PDFs and waits for receipt',async()=>{
  const portal=hostedPortal(url);
  assert.equal(portal.provider,name);
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage();
    let submitted=0, approvedClicks=0;
    const cv=await makePdf('Mira Beispiel','Fiktiver Lebenslauf');
    const letter=await makePdf('Bewerbung','Fiktives Anschreiben');
    const docs=[{name:'cv.pdf',kind:'cv',bytes:cv},{name:'brief.pdf',kind:'letter',bytes:letter}];
    const docsMarkup='<label>Upload Lebenslauf<input type=file name="documents.cv"></label><label>Upload Andere<input type=file name="documents.other"></label>';
    const contact='<label>Vorname<input name="first_name" required></label><label>E-Mail<input type=email name=email required></label>';
    const consent='<label>Ich akzeptiere die <a href="/terms">AGB</a><input type=checkbox name=terms required></label><label>Newsletter<input type=checkbox name=newsletter checked></label>';
    const multi=name==='JOIN';
    const finalButton='<button type="submit">Bewerbung senden</button>';
    await page.route('**/*',async route=>{
      const req=route.request();
      if(req.url()===portal.apply && req.method()==='GET')return route.fulfill({contentType:'text/html',body:'<main><form enctype="multipart/form-data" method="POST">'+contact+consent+
        (multi?'<button type="button" onclick="if(this.form.terms.checked&&!this.form.newsletter.checked)location.href=location.pathname+\'/documents\'">Weiter</button>':docsMarkup+finalButton)+'</form></main>'});
      if(multi&&req.url()===portal.apply+'/documents'&&req.method()==='GET')
        return route.fulfill({contentType:'text/html',body:'<form method="post" enctype="multipart/form-data">'+docsMarkup+finalButton+'</form>'});
      if(req.method()==='POST'&&req.url().startsWith(portal.apply)){
        const body=req.postDataBuffer();
        assert.ok(body.includes(cv)&&body.includes(letter));
        if(!multi) {
          assert.ok(body.includes(Buffer.from('Mira')));
          assert.ok(body.includes(Buffer.from('mira@example.invalid')));
          assert.match(body.toString(),/name="terms"\r\n\r\non\r\n/);
          assert.doesNotMatch(body.toString(),/name="newsletter"/);
        }
        submitted++;
        return route.fulfill({contentType:'text/html',body:'<main>Thank you for applying.</main>'});
      }
      return route.abort();
    });
    await page.goto(portal.apply);
    const answers=contactFields().map(a=>({...a,value:({first_name:'Mira',last_name:'Beispiel',email:'mira@example.invalid'})[a.key]||''}));
    const job={answers,letter:'Fiktives Anschreiben'};
    const unseen=await hostedStep(page,job,docs,new Set());
    assert.equal(unseen.status,'blocked');
    assert.equal(await page.locator('input[name=first_name]').inputValue(),'');
    assert.equal(submitted,0);
    assert.equal(unseen.fields[0].type,'application-consent');
    assert.equal(unseen.fields[0].value,'Ja');
    assert.deepEqual(unseen.fields[0].links,[new URL('/terms',portal.apply).href]);
    job.answers.push(unseen.fields[0]);
    const termsLink=page.getByRole('link',{name:'AGB'});
    await termsLink.evaluate(link=>link.setAttribute('href','/new-terms'));
    const changed=await hostedStep(page,job,docs,new Set());
    assert.equal(changed.status,'blocked');
    assert.notEqual(changed.fields[0].key,job.answers.at(-1).key);
    assert.equal(await page.locator('[name=terms]').isChecked(),false);
    await termsLink.evaluate(link=>link.setAttribute('href','/terms'));
    const result=await submitHosted(page,job,docs,{portal,headless:true,onSubmit:()=>{approvedClicks++;}});
    assert.equal(result.status,'sent',JSON.stringify(result));
    assert.equal(submitted,1);
    assert.equal(approvedClicks,1);
  } finally {await browser.close();}
});
test('Portal routing binds tenant, job and submission path',()=>{
  for(const u of ['https://join.com/companies/x','https://join.com.attacker.invalid/companies/x/777',
    'https://test.jobs.personio.de:8443/job/333','http://test.jobs.personio.de/job/333','https://jobs.lever.co/beispiel/not-a-job'])
    assert.equal(hostedPortal(u),null);
  assert.notEqual(hostedPortal('https://join.com/companies/team/41').apply,hostedPortal('https://join.com/companies/team/42').apply);
});
