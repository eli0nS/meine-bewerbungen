import { randomUUID } from 'node:crypto';
import { makePdf } from './documents.mjs';

export const demoProfile = {
  name: 'Mira Beispiel', email: 'mira.beispiel@example.invalid', phone: '+49 30 00000000', city: 'Beispielstadt',
  notice: 'Vier Wochen', criteria: 'Entwicklung und Testing · Beispielstadt · Vollzeit · ab 60.000 € · Hybrid',
  evidence: 'Seit 2023 entwickle ich im fiktiven Unternehmen Nordlicht Labor modulare Prüfaufbauten. Ich plane Messreihen, integriere Sensoren und dokumentiere Fehler. Meine Weiterbildung zur staatlich geprüften Technikerin habe ich 2022 abgeschlossen. Ein wiederverwendbarer Aufbau hat die Vorbereitung vereinfacht.'
};
export const demoListing = {
  employer: 'Nordstern Systeme · fiktiv', title: 'Entwicklungsingenieur:in Prüfsysteme', location: 'Beispielstadt · Hybrid',
  description: 'Entwickle modulare Prüfsysteme, integriere Sensoren und begleite Testreihen von der Planung bis zur dokumentierten Auswertung. Technische Weiterbildung oder Studium. Vollzeit, 40 Stunden pro Woche. 60.000–72.000 € brutto jährlich. Dieses Unternehmen und die Stelle sind ausschließlich fiktive Testdaten.',
  fit: 'Deine belegten Prüfaufbauten, Sensorintegration und Messreihen passen zu den Hauptaufgaben.', gaps: 'Konkrete Steuerungssoftware im Vorstellungsgespräch klären.'
};
export async function seedDemo(store) {
  const cv=await makePdf('Mira Beispiel · Fiktiver Lebenslauf', `${demoProfile.city}\n${demoProfile.email}\n\nTechnische Entwicklung und Test\n${demoProfile.evidence}\n\nSprachen: Deutsch C2, Englisch B2\nDieses Dokument enthält ausschließlich erfundene Angaben.`);
  const previous=store.documents().find(doc=>doc.kind==='cv');
  if(previous) return previous;
  const state = store.read();
  state.profile = { ...demoProfile };
  state.template ||= 'Mit einer konkreten Aufgabe beginnen. Die technische Weiterbildung früh nennen und mit einem kurzen Gesprächswunsch schließen.';
  const doc = store.addDocument('Lebenslauf_Mira_Beispiel.pdf', 'cv', cv);
  store.event(state, '', 'Fiktiven Lebenslauf und Demoprofil lokal geladen.');
  store.save(state);
  return doc;
}
export function demoLetter(profile, template) {
  return `Bewerbung als Entwicklungsingenieur:in Prüfsysteme\n\nSehr geehrtes Nordstern-Team,\n\nbei Nordlicht Labor entwickle ich modulare Prüfaufbauten und plane die zugehörigen Messreihen. Ich integriere Sensoren und halte Fehler so fest, dass die Entwicklung sie nachvollziehen kann. Diese Erfahrung möchte ich in Ihre Prüfsysteme einbringen.\n\nMeine Weiterbildung zur staatlich geprüften Technikerin habe ich 2022 abgeschlossen. Ein wiederverwendbarer Aufbau hat die Vorbereitung unserer Versuche vereinfacht. Bei Ihrer Stelle interessiert mich besonders, die technische Entwicklung bis zur Auswertung der Testreihen zu begleiten.\n\n${template.includes('Gespräch') ? 'Ich freue mich darauf, Ihre Aufgaben in einem persönlichen Gespräch kennenzulernen.' : 'Gerne erläutere ich Ihnen meinen Beitrag in einem Gespräch.'}\n\nMit freundlichen Grüßen\n${profile.name}`;
}
export function newJob(fields) {
  return { id: randomUUID(), revision: 1, status: 'prepared', approval: null, blocker: '', letter: '', answers: [], attachments: [], ...fields };
}
