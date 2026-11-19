import { createHash } from 'node:crypto';

function applicationConsent(label, required) {
  if (!required) return false;
  // Positive acceptance of terms for the current application. Other declarations
  // (like a talent pool or a claim about the applicant) still need their own answer.
  return /\b(agb|nutzungsbedingungen|datenschutz(?:erklärung|hinweise)?|terms (?:of (?:use|service)|and conditions)|privacy (?:policy|notice)|data protection)\b/iu.test(label)
    && !/newsletter|marketing|tracking|cookies?|talent[\s-]*pool|bewerber[\s-]*pool|talent community|künftig|future|andere stellen|other positions|widersprech|\b(?:werbung|advertising|nicht|not|decline|reject|opt[ -]out)\b/iu.test(label);
}

export async function inspectCheckboxes(scope, answers, address, inspectOnly = false) {
  const inputs = scope.locator('input[type="checkbox"]');
  const pagePath = new URL(address).pathname.replace(/\/$/, '');
  const controls = await inputs.evaluateAll(elements => elements.flatMap((element, index) => {
    if (element.disabled || element.getAttribute('aria-hidden') === 'true' || !element.getClientRects().length) return [];
    const labels = [...(element.labels || []), ...String(element.getAttribute('aria-labelledby') || '')
      .split(/\s+/).map(id => document.getElementById(id)).filter(Boolean)];
    const label = (labels.map(node => node.textContent).join(' ') || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    return [{index, label, name: element.name || element.id, value: element.value,
      required: element.required || element.getAttribute('aria-required') === 'true' || label.endsWith('*'),
      links: labels.flatMap(node => [...node.querySelectorAll('a[href]')].map(link => link.getAttribute('href')))}];
  }));
  const fields = [], actions = [], seen = new Set();
  for (const control of controls) {
    const {label, name, required} = control;
    if (!label && required) return {message: 'Eine Pflichtbestätigung im Portal hat keine erkennbare Beschriftung.'};
    const links = [...new Set(control.links.map(raw => {
      try {
        const url = new URL(raw, address);
        if (url.protocol === 'https:' && !url.username && !url.password && !raw.startsWith('#')) return url.href;
      } catch { /* The label is still available even when a link cannot be opened. */ }
      return '';
    }).filter(Boolean))];
    if (label.length > 1000 || links.length > 12 || links.some(link => link.length > 2000))
      return {message: 'Die Portalbestätigung ist zu umfangreich für die Freigabe im Dashboard.'};
    const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0,24);
    const key = 'portal_' + hash([pagePath, label, name, 'checkbox', required, control.value, control.links, links]);
    if (seen.has(key)) return {message: 'Das Portal enthält mehrdeutige Kontrollkästchen.'};
    seen.add(key);
    const known = answers.find(answer => answer.key === key);
    const automatic = applicationConsent(label, required);
    const duplicateName = name && controls.some(other => other !== control && other.name === name);
    const checkboxId = hash([pagePath, duplicateName ? [name, control.value, label] : name || label]);
    if (!known && (required || (inspectOnly && label) || answers.some(answer => answer.checkboxId === checkboxId))) {
      fields.push({key, label: label || name, type: automatic ? 'application-consent' : 'checkbox', required,
        options:['Ja','Nein'], value: automatic ? 'Ja' : '', checkboxId,
        previousKey: 'portal_' + hash([label, name, 'checkbox', required, ['Ja','Nein']]), ...(links.length ? {links} : {})});
      continue;
    }
    if (required && known?.value !== 'Ja') return {message: 'Bitte die Pflichtbestätigung prüfen: ' + known.label};
    actions.push(() => inputs.nth(control.index).setChecked(known?.value === 'Ja'));
  }
  return {fields, actions};
}

export const checkboxBlocked = message => ({status:'blocked',message});
export const checkboxReview = fields => ({...checkboxBlocked('Neue Pflichtbestätigungen oder Fragen stehen zur Prüfung bereit. Bitte gib die aktualisierte Fassung frei.'),fields});
