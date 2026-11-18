import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function makePdf(title, text) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page, y;
  const fresh = () => { page = pdf.addPage([595, 842]); y = 780; };
  fresh();
  // Standard PDF fonts use WinAnsi. Preserve German characters and normalize unsupported punctuation.
  const safe = value => [...value.replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'")].map(char => {
    try { font.encodeText(char); return char; } catch { return '?'; }
  }).join('');
  for (const [index, paragraph] of [title, ...text.split('\n')].entries()) {
    const active = index === 0 ? bold : font;
    const size = index === 0 ? 15 : 11;
    let line = '';
    for (const word of safe(paragraph).split(' ')) {
      if (active.widthOfTextAtSize(`${line} ${word}`, size) > 475 && line) {
        if (y < 60) fresh();
        page.drawText(line, { x: 60, y, size, font: active, color: rgb(.12,.18,.2) }); y -= 17; line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (y < 60) fresh();
    page.drawText(line, { x: 60, y, size, font: active, color: rgb(.12,.18,.2) }); y -= index === 0 ? 35 : 25;
  }
  return Buffer.from(await pdf.save());
}
