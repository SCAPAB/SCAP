/**
 * Skapar DEMODOKUMENT (PDF) som matchar demodatan, samt förinspelade AI-svar för demoläget.
 *   npm run demo:docs   → data/demo-dokument/*.pdf och data/demo-dokument/ai/<sha256>.json
 * Starta sedan med INNEHAV_AI_MOCK=data/demo-dokument/ai (npm run dev:demo) och ladda upp PDF:erna i Inkorgen.
 * Allt innehåll är fiktivt.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get } from '../server/db.ts';
import { Market, peHolding, listedHolding, addDays } from '../server/calc.ts';
import type { Instrument, Transaction } from '../shared/types.ts';

const OUT = join(process.cwd(), 'data', 'demo-dokument');
mkdirSync(join(OUT, 'ai'), { recursive: true });

const market = new Market({
  prices: all('SELECT instrument_id, date, price FROM prices'),
  fx: all('SELECT currency, date, rate FROM fx_rates'),
  valuations: all('SELECT entity_id, instrument_id, date, nav FROM pe_valuations'),
});
const ins = (name: string) => get<Instrument>('SELECT * FROM instruments WHERE name=?', name)!;
const ent = (name: string) => get<{ id: number; name: string; org_nr: string }>('SELECT * FROM entities WHERE name=?', name)!;
const txs = (e: number, i: number) => all<Transaction>('SELECT * FROM transactions WHERE entity_id=? AND instrument_id=?', e, i);
const today = new Date().toISOString().slice(0, 10);
const weekday = (d: string, dir: -1 | 1) => { let x = d; while ([0, 6].includes(new Date(x + 'T00:00:00Z').getUTCDay())) x = addDays(x, dir); return x; };
const quarterEnd = (() => { const d = new Date(today + 'T00:00:00Z'); const q = Math.floor(d.getUTCMonth() / 3); return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 0)).toISOString().slice(0, 10); })();
const monthEnd = weekday(new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10), -1);
const r2 = (x: number) => Math.round(x * 100) / 100;
const en = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sv = (n: number, d = 2) => n.toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/[\u00a0\u202f]/g, ' ').replace(/\u2212/g, '-');
const longDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// Fält i AI-svaret
const F = (value: unknown, quote: string | null = null, confidence: 'high' | 'medium' | 'low' = 'high', page = 1) => ({ value, confidence, page: value == null ? null : page, quote: value == null ? null : quote });
const N = () => F(null);
const item = (o: Record<string, unknown>) => ({
  investor_label: N(), instrument_name: N(), isin: N(), date: N(), settle_date: N(), currency: N(), quantity: N(), price: N(), amount: N(), fee: N(),
  commitment_total: N(), paid_in_total: N(), unfunded: N(), distributed_total: N(), line_items: [], note: null, ...o,
});

// Enkel PDF-layout
class Doc {
  pdf!: PDFDocument; page!: PDFPage; font!: PDFFont; bold!: PDFFont; y = 800;
  static async create() { const d = new Doc(); d.pdf = await PDFDocument.create(); d.font = await d.pdf.embedFont(StandardFonts.Helvetica); d.bold = await d.pdf.embedFont(StandardFonts.HelveticaBold); d.page = d.pdf.addPage([595, 842]); return d; }
  text(t: string, x: number, size = 10, b = false, color = rgb(0.1, 0.1, 0.1)) { this.page.drawText(t, { x, y: this.y, size, font: b ? this.bold : this.font, color }); }
  line(t: string, size = 10, b = false, x = 50) { this.text(t, x, size, b); this.y -= size + 6; }
  gap(n = 10) { this.y -= n; }
  rule() { this.page.drawLine({ start: { x: 50, y: this.y + 4 }, end: { x: 545, y: this.y + 4 }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) }); this.y -= 8; }
  row(cells: string[], xs: number[], b = false, rightFrom = 1) {
    cells.forEach((c, i) => { const f = b ? this.bold : this.font; const x = i >= rightFrom ? xs[i] - f.widthOfTextAtSize(c, 9) : xs[i]; this.page.drawText(c, { x, y: this.y, size: 9, font: f }); });
    this.y -= 15;
  }
  header(company: string, sub: string) {
    this.page.drawRectangle({ x: 0, y: 792, width: 595, height: 50, color: rgb(0.13, 0.2, 0.32) });
    this.page.drawText(company, { x: 50, y: 812, size: 15, font: this.bold, color: rgb(1, 1, 1) });
    this.page.drawText(sub, { x: 50, y: 798, size: 8, font: this.font, color: rgb(0.85, 0.88, 0.95) });
    this.y = 760;
  }
  footer(t: string) { this.page.drawText(t, { x: 50, y: 30, size: 7, font: this.font, color: rgb(0.45, 0.45, 0.45) }); }
  async save(name: string, extraction: unknown) {
    const bytes = await this.pdf.save({ useObjectStreams: false });
    const buf = Buffer.from(bytes);
    writeFileSync(join(OUT, name), buf);
    const sha = createHash('sha256').update(buf).digest('hex');
    writeFileSync(join(OUT, 'ai', `${sha}.json`), JSON.stringify(extraction, null, 1));
    console.log(`  ${name}`);
  }
}

console.log(`Skapar demodokument i ${OUT}`);

// 1. Kapitalanrop – Nordic Buyout Partners IV, Demo Holding AB
{
  const fund = ins('Nordic Buyout Partners IV'); const e = ent('Demo Holding AB');
  const h = peHolding(fund, e.id, txs(e.id, fund.id), market, today);
  const invest = Math.round(Math.min(h.uncalled * 0.55, 650_000) / 100) * 100;
  const mgmt = 37_500; const exp = 4_213.8; const total = r2(invest + mgmt + exp);
  const due = weekday(addDays(today, 10), 1); const notice = weekday(addDays(today, -2), -1);
  const d = await Doc.create();
  d.header('Exempel Partners', 'Nordic Buyout Partners IV SCSp  ·  2 Rue de l\'Exemple, L-1000 Luxembourg');
  d.line('CAPITAL CALL NOTICE No. 24', 16, true); d.gap(4);
  d.line(`Date of notice: ${longDate(notice)}`); d.line(`To: ${e.name} (Investor No. 0117)`); d.gap(8);
  d.line('Dear Limited Partner,'); d.line('In accordance with the Limited Partnership Agreement, the General Partner hereby calls capital as follows.'); d.gap(8);
  const xs = [50, 545];
  d.row(['Description', 'Amount (EUR)'], xs, true); d.rule();
  d.row(['Investment in portfolio company – Project Falcon', en(invest)], xs);
  d.row(['Management fee Q4 2026', en(mgmt)], xs);
  d.row(['Partnership expenses', en(exp)], xs); d.rule();
  d.row(['Total amount due', en(total)], xs, true); d.gap(10);
  d.line(`Due Date: ${longDate(due)}`, 11, true);
  d.line(`Your commitment: EUR ${en(h.commitment)}`); d.line(`Unfunded commitment before this call: EUR ${en(h.uncalled)}`);
  d.line(`Unfunded commitment after this call: EUR ${en(h.uncalled - total)}`); d.gap(10);
  d.line('Please remit the amount to: Exempelbanken S.A., IBAN LU00 0000 0000 0000 0000, Ref: NBP IV CC24 0117', 9);
  d.footer('Demodokument – fiktivt innehåll skapat av Innehav.');
  await d.save('1 Kapitalanrop Nordic Buyout Partners IV.pdf', {
    document_type: 'capital_call', summary: `Kapitalanrop nr 24 från Nordic Buyout Partners IV till ${e.name} med förfallodag ${due}.`,
    issuer: F('Exempel Partners', 'Exempel Partners'), investor_label: F(`${e.name} (Investor No. 0117)`, `To: ${e.name} (Investor No. 0117)`),
    items: [item({
      kind: 'CALL', investor_label: F(`${e.name} (Investor No. 0117)`, `To: ${e.name} (Investor No. 0117)`),
      instrument_name: F('Nordic Buyout Partners IV SCSp', 'Nordic Buyout Partners IV SCSp'), date: F(due, `Due Date: ${longDate(due)}`),
      currency: F('EUR', 'Amount (EUR)'), amount: F(total, `Total amount due ${en(total)}`), fee: F(r2(mgmt + exp), `Management fee Q4 2026 ${en(mgmt)} · Partnership expenses ${en(exp)}`, 'medium'),
      line_items: [
        { description: 'Investment in portfolio company – Project Falcon', amount: invest, category: 'investment', page: 1 },
        { description: 'Management fee Q4 2026', amount: mgmt, category: 'mgmt_fee', page: 1 },
        { description: 'Partnership expenses', amount: exp, category: 'expenses', page: 1 },
      ],
      note: 'Avgiftsbeloppet är summan av förvaltningsavgift och fondkostnader.',
    })],
    warnings: [],
  });
}

// 2. Kapitalkontoutdrag – Scandinavian Growth Fund II, två av våra enheter + en annan investerare
{
  const fund = ins('Scandinavian Growth Fund II');
  const rows = ['Demo Holding AB', 'Demo Stiftelse'].map((n) => {
    const e = ent(n);
    const h = peHolding(fund, e.id, txs(e.id, fund.id), market, quarterEnd);
    return { e, h, nav: Math.round(h.nav * 1.027) };
  });
  // Avsiktlig avvikelse för demo: GP har registrerat ett anrop som saknas i bokföringen för Demo Stiftelse
  const missing = 2_000_000;
  const d = await Doc.create();
  d.header('Exempel Growth AB', 'Scandinavian Growth Fund II AB  ·  Kapitalkontoutdrag / Capital Account Statement');
  d.line('CAPITAL ACCOUNT STATEMENT', 16, true); d.line(`As of ${longDate(quarterEnd)}  ·  All amounts in SEK`); d.gap(10);
  const xs = [50, 260, 380, 470, 545];
  d.row(['Investor', 'Commitment', 'Paid-in capital', 'Distributions', 'Unfunded'], xs, true); d.rule();
  const vals = rows.map(({ e, h }, i) => ({ name: e.name, commit: h.commitment, paid: h.paidIn + (i === 1 ? missing : 0), dist: h.distributed, unf: h.uncalled - (i === 1 ? missing : 0) }));
  for (const v of vals) d.row([v.name, sv(v.commit, 0), sv(v.paid, 0), sv(v.dist, 0), sv(v.unf, 0)], xs);
  d.row(['Pensionskassan Exempel', sv(100_000_000, 0), sv(92_000_000, 0), sv(12_126_456, 0), sv(8_000_000, 0)], xs);
  d.gap(16);
  d.row(['Investor', 'NAV before carry', 'Accrued carry', 'NAV after carry', ''], [50, 260, 380, 470, 545], true); d.rule();
  rows.forEach(({ e, nav }) => d.row([e.name, sv(nav * 1.04, 0), sv(-(nav * 0.04), 0), sv(nav, 0), ''], [50, 260, 380, 470, 545]));
  d.row(['Pensionskassan Exempel', sv(91_200_000, 0), sv(-3_648_000, 0), sv(87_552_000, 0), ''], [50, 260, 380, 470, 545]);
  d.gap(16); d.line('Valuation in accordance with IPEV Valuation Guidelines. Figures are unaudited.', 8);
  d.footer('Demodokument – fiktivt innehåll skapat av Innehav.');
  await d.save('2 Kapitalkontoutdrag Scandinavian Growth Fund II.pdf', {
    document_type: 'capital_account_statement', summary: `Kapitalkontoutdrag per ${quarterEnd} för tre investerare, varav två är våra enheter.`,
    issuer: F('Exempel Growth AB', 'Exempel Growth AB'), investor_label: F('Demo Holding AB', 'Demo Holding AB'),
    items: rows.map(({ e, nav }, i) => item({
      kind: 'NAV', investor_label: F(e.name, e.name), instrument_name: F('Scandinavian Growth Fund II AB', 'Scandinavian Growth Fund II AB'),
      date: F(quarterEnd, `As of ${longDate(quarterEnd)}`), currency: F('SEK', 'All amounts in SEK'),
      amount: F(nav, `${e.name} ... NAV after carry ${sv(nav, 0)}`),
      commitment_total: F(vals[i].commit, sv(vals[i].commit, 0)), paid_in_total: F(vals[i].paid, sv(vals[i].paid, 0)),
      distributed_total: F(vals[i].dist, sv(vals[i].dist, 0)), unfunded: F(vals[i].unf, sv(vals[i].unf, 0)),
      note: 'NAV efter upplupen carried interest.',
    })),
    warnings: ['Dokumentet innehåller även investeraren "Pensionskassan Exempel" som inte är en av era enheter – den har hoppats över.'],
  });
}

// 3. Avräkningsnota fond – köp av Demo Global Indexfond, Demo Stiftelse
{
  const fund = ins('Demo Global Indexfond'); const e = ent('Demo Stiftelse');
  const td = weekday(addDays(today, -3), -1); const settle = weekday(addDays(td, 2), 1);
  const px = market.price(fund.id, td)!.value; const units = 12_500; const amount = r2(units * px);
  const d = await Doc.create();
  d.header('Demo Fonder AB', 'Box 0000, 100 00 Stockholm  ·  Org.nr 556999-0000');
  d.line('AVRÄKNINGSNOTA – KÖP AV FONDANDELAR', 14, true); d.gap(6);
  d.line(`Kund: ${e.name}`); d.line(`Org.nr: ${e.org_nr}`); d.line('Kundnummer: 448812'); d.gap(10);
  const xs = [50, 300];
  const r = (a: string, b: string, bold = false) => d.row([a, b], xs, bold, 9);
  r('Fond', fund.name); r('Transaktion', 'Köp'); r('Affärsdag', td); r('Antal andelar', sv(units, 4)); r('NAV-kurs', `${sv(px, 2)} SEK`);
  r('Belopp', `${sv(amount, 2)} SEK`, true); r('Avgift', '0,00 SEK'); r('Likviddag', 'Enligt fondens villkor (T+2)');
  d.gap(12); d.line('Likvid dras från ert anslutna konto. Kontrollera avräkningsnotan och kontakta oss vid avvikelse.', 8);
  d.footer('Demodokument – fiktivt innehåll skapat av Innehav.');
  await d.save('3 Avräkningsnota Demo Global Indexfond.pdf', {
    document_type: 'fund_trade_confirmation', summary: `Köp av ${sv(units, 0)} andelar i ${fund.name} för ${e.name}, affärsdag ${td}.`,
    issuer: F('Demo Fonder AB', 'Demo Fonder AB'), investor_label: F(`${e.name}, org.nr ${e.org_nr}`, `Kund: ${e.name} Org.nr: ${e.org_nr}`),
    items: [item({
      kind: 'BUY', investor_label: F(`${e.name}, org.nr ${e.org_nr}`, `Org.nr: ${e.org_nr}`), instrument_name: F(fund.name, `Fond ${fund.name}`),
      date: F(td, `Affärsdag ${td}`), settle_date: F(settle, 'Likviddag Enligt fondens villkor (T+2)', 'low'), currency: F('SEK', 'SEK'),
      quantity: F(units, `Antal andelar ${sv(units, 4)}`), price: F(px, `NAV-kurs ${sv(px, 2)} SEK`), amount: F(amount, `Belopp ${sv(amount, 2)} SEK`), fee: F(0, 'Avgift 0,00 SEK'),
      note: 'Likviddagen står inte som datum utan som "T+2" – beräknad från affärsdagen.',
    })],
    warnings: ['Likviddag är beräknad (T+2), kontrollera mot bankkontot.'],
  });
}

// 4. Innehavsbesked från depåbank – Demo Pensionsstiftelse
{
  const e = ent('Demo Pensionsstiftelse');
  const listed = all<Instrument>("SELECT * FROM instruments WHERE type != 'PE_FUND' ORDER BY name");
  const held = listed.map((i) => ({ i, h: listedHolding(i, e.id, txs(e.id, i.id), market, monthEnd) })).filter((x) => x.h.quantity > 0).slice(0, 4);
  // Avsiktlig avvikelse för demo: depåbanken visar 1 500 fler aktier i första innehavet
  const lines = held.map((x, k) => ({ ...x, qty: x.h.quantity + (k === 0 ? 1500 : 0), px: market.price(x.i.id, monthEnd)!.value }));
  const d = await Doc.create();
  d.header('Exempelbanken Depåtjänster', 'Innehavsbesked  ·  Depå 9021-445 778');
  d.line('INNEHAVSBESKED', 16, true); d.line(`Depåägare: ${e.name} (${e.org_nr})`); d.line(`Per datum: ${monthEnd}`); d.gap(10);
  const xs = [50, 190, 330, 430, 545];
  d.row(['Värdepapper', 'ISIN', 'Antal', 'Kurs', 'Marknadsvärde'], xs, true, 2); d.rule();
  for (const l of lines) d.row([l.i.name, l.i.isin ?? '–', sv(l.qty, 0), `${sv(l.px, 2)} ${l.i.currency}`, `${sv(l.qty * l.px, 2)} ${l.i.currency}`], xs, false, 2);
  d.gap(12); d.line('Kurser avser senast betalt eller NAV-kurs per angivet datum.', 8);
  d.footer('Demodokument – fiktivt innehåll skapat av Innehav.');
  await d.save('4 Innehavsbesked Demo Pensionsstiftelse.pdf', {
    document_type: 'holdings_statement', summary: `Innehavsbesked från depåbanken för ${e.name} per ${monthEnd} med ${lines.length} innehav.`,
    issuer: F('Exempelbanken Depåtjänster', 'Exempelbanken Depåtjänster'), investor_label: F(`${e.name} (${e.org_nr})`, `Depåägare: ${e.name} (${e.org_nr})`),
    items: lines.map((l, k) => item({
      kind: 'HOLDING', investor_label: F(`${e.name} (${e.org_nr})`, `Depåägare: ${e.name} (${e.org_nr})`),
      instrument_name: F(l.i.name, l.i.name), isin: F(l.i.isin, l.i.isin), date: F(monthEnd, `Per datum: ${monthEnd}`), currency: F(l.i.currency, l.i.currency),
      quantity: F(l.qty, `${l.i.name} ${sv(l.qty, 0)}`), price: F(l.px, `${sv(l.px, 2)} ${l.i.currency}`, k === 2 ? 'medium' : 'high'),
      amount: F(r2(l.qty * l.px), `${sv(l.qty * l.px, 2)} ${l.i.currency}`),
    })),
    warnings: [],
  });
}
// 5. Utdelningsbesked från parallellvehikel med återinkallningsbar del – European Mid-Market Fund VI, Demo Pensionsstiftelse
{
  const e = ent('Demo Pensionsstiftelse');
  const pay = weekday(addDays(today, -6), -1);
  const roc = 310_000; const gain = 145_250.4; const income = 18_400; const wht = 0;
  const gross = r2(roc + gain + income);
  const d = await Doc.create();
  d.header('Exempel Capital', 'European Mid-Market Fund VI (No. 2) SCSp  ·  Luxembourg');
  d.line('DISTRIBUTION NOTICE', 16, true); d.gap(4);
  d.line(`Payment date: ${longDate(pay)}`); d.line(`Limited Partner: ${e.name}  ·  Investor ID 30042`); d.gap(10);
  const xs = [50, 545];
  d.row(['Component', 'Amount (EUR)'], xs, true); d.rule();
  d.row(['Return of capital – bridge financing (recallable)', en(roc)], xs);
  d.row(['Realised gain – sale of Nordic Packaging Group', en(gain)], xs);
  d.row(['Interest income', en(income)], xs);
  d.row(['Withholding tax', en(wht)], xs); d.rule();
  d.row(['Net distribution', en(gross - wht)], xs, true); d.gap(10);
  d.line('The return of capital is recallable in accordance with clause 6.4 of the LPA and increases your unfunded commitment accordingly.', 8);
  d.footer('Demodokument – fiktivt innehåll skapat av Innehav.');
  await d.save('5 Utdelning European Mid-Market Fund VI.pdf', {
    document_type: 'distribution_notice', summary: `Utdelning från European Mid-Market Fund VI (parallellvehikel No. 2) till ${e.name}, varav ${en(roc, 0)} EUR återinkallningsbart.`,
    issuer: F('Exempel Capital', 'Exempel Capital'), investor_label: F(`${e.name} (Investor ID 30042)`, `Limited Partner: ${e.name} · Investor ID 30042`),
    items: [item({
      kind: 'DISTRIBUTION', investor_label: F(`${e.name} (Investor ID 30042)`, `Limited Partner: ${e.name} · Investor ID 30042`),
      instrument_name: F('European Mid-Market Fund VI (No. 2) SCSp', 'European Mid-Market Fund VI (No. 2) SCSp'),
      date: F(pay, `Payment date: ${longDate(pay)}`), currency: F('EUR', 'Amount (EUR)'),
      amount: F(gross, `Net distribution ${en(gross - wht)}`), fee: F(wht, `Withholding tax ${en(wht)}`),
      line_items: [
        { description: 'Return of capital – bridge financing (recallable)', amount: roc, category: 'recallable', page: 1 },
        { description: 'Realised gain – sale of Nordic Packaging Group', amount: gain, category: 'gain', page: 1 },
        { description: 'Interest income', amount: income, category: 'income', page: 1 },
      ],
      note: 'Återbetalt kapital är återinkallningsbart enligt LPA 6.4.',
    })],
    warnings: ['Dokumentet avser parallellvehikeln "(No. 2)" – kontrollera att det är samma åtagande som i registret.'],
  });
}
console.log('Klart. Starta med: npm run dev:demo');
