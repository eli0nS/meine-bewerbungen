import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const now = () => new Date().toISOString();
export const initialState = () => ({ profile: { name: '', email: '', phone: '', city: '', evidence: '', criteria: '', notice: '' }, template: '', jobs: [], events: [], provider: 'codex' });

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, bytes BLOB NOT NULL);');
    if (!this.db.prepare('SELECT value FROM state WHERE id=1').get()) {
      const first=initialState();
      if(process.env.ATELIER_START_PROVIDER==='claude') first.provider='claude';
      this.save(first);
    }
    const state = this.read();
    for (const job of state.jobs) {
      if (job.status === 'sending') {
        job.status = 'unknown';
        job.approval = null;
        this.event(state, job.id, 'Versand durch Neustart unterbrochen. Ausgang muss geprüft werden.');
      }
    }
    this.save(state);
  }
  read() { return JSON.parse(this.db.prepare('SELECT value FROM state WHERE id=1').get().value); }
  save(state) { this.db.prepare('INSERT OR REPLACE INTO state(id,value) VALUES(1,?)').run(JSON.stringify(state)); }
  documents() { return this.db.prepare('SELECT id,name,kind,hash,length(bytes) AS size FROM documents ORDER BY rowid DESC').all(); }
  document(id) { return this.db.prepare('SELECT * FROM documents WHERE id=?').get(id); }
  addDocument(name, kind, bytes) {
    const doc = { id: randomUUID(), name, kind, hash: digest(bytes) };
    this.db.prepare('INSERT INTO documents(id,name,kind,hash,bytes) VALUES(?,?,?,?,?)').run(doc.id, name, kind, doc.hash, bytes);
    return doc;
  }
  removeOtherSamples(keep='') {
    this.db.prepare("DELETE FROM documents WHERE kind='sample' AND id<>?").run(keep);
  }
  event(state, jobId, message) { state.events.unshift({ id: randomUUID(), jobId, message, time: now() }); }
  snapshot(job, state) {
    return digest({ employer: job.employer, title: job.title, target: job.target, applyTarget:job.applyTarget, source: job.source, letter: job.letter, answers: job.answers, attachments: job.attachments.map(id => {
      const doc = this.document(id);
      if (!doc) throw new Error('Eine Anlage fehlt. Bitte erneut prüfen.');
      if (doc.hash !== digest(Buffer.from(doc.bytes))) throw new Error('Die Dateiprüfung ist fehlgeschlagen.');
      return { id, name: doc.name, hash: doc.hash };
    }), profile: state.profile, revision: job.revision });
  }
  invalidate(state, job, message) {
    if (['sending', 'sent', 'unknown'].includes(job.status)) throw new Error('Dieser Versandvorgang ist gesperrt.');
    job.revision++;
    job.approval = null;
    job.status = 'prepared';
    job.blocker = '';
    this.event(state, job.id, message);
  }
  close() { this.db.close(); }
}
