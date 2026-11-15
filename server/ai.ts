/**
 * AI-tolkning av underlag (PDF/bild) med Claude.
 *
 * Princip: AI:n FÖRESLÅR. Varje fält returneras med värde, säkerhetsgrad, sidnummer och ett
 * ordagrant citat ur dokumentet så att användaren kan kontrollera förslaget mot källan.
 * Inget sparas utan att en människa har godkänt posten (se proposals.ts).
 *
 * Kräver ANTHROPIC_API_KEY. Utan nyckel hanteras dokument manuellt i samma granskningsflöde.
 * INNEHAV_AI_MOCK=<katalog> används endast för demo/tester: läser förinspelade svar <sha256>.json.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const AI_MODEL = process.env.INNEHAV_AI_MODEL ?? 'claude-opus-5-5';

const Confidence = z.enum(['high', 'medium', 'low']).describe(
  'high = står uttryckligen i dokumentet; medium = härlett/beräknat eller tvetydigt; low = osäker gissning',
);
const fieldOf = <T extends z.ZodType>(t: T) =>
  z.object({
    value: t.nullable(),
    confidence: Confidence,
    page: z.number().int().nullable().describe('1-indexerat sidnummer där värdet står'),
    quote: z.string().nullable().describe('Ordagrant utdrag (max ~120 tecken) ur dokumentet som visar värdet'),
  });
const Str = fieldOf(z.string());
const Num = fieldOf(z.number());

export const ITEM_KINDS = ['CALL', 'DISTRIBUTION', 'NAV', 'COMMITMENT', 'BUY', 'SELL', 'DIVIDEND', 'FEE', 'PRICE', 'HOLDING'] as const;
export const DOC_TYPES = [
  'capital_call', 'distribution_notice', 'capital_account_statement', 'fund_trade_confirmation',
  'equity_trade_confirmation', 'dividend_notice', 'holdings_statement', 'other',
] as const;

const Item = z.object({
  kind: z.enum(ITEM_KINDS).describe(
    'CALL=kapitalanrop/drawdown, DISTRIBUTION=utdelning/återbetalning från PE-fond, NAV=kapitalkontots värde (CAS), ' +
    'COMMITMENT=nytt/ändrat åtagande, BUY/SELL=köp/sälj av fondandelar eller aktier, DIVIDEND=aktieutdelning, FEE=avgift, ' +
    'PRICE=kurs/NAV-kurs per andel, HOLDING=antal andelar/aktier enligt innehavsbesked',
  ),
  investor_label: Str.describe('Investerarens namn/kontonummer ORDAGRANT som det står på raden/kolumnen värdena för denna post hämtades från'),
  instrument_name: Str.describe('Fondens/aktiens namn som det står i dokumentet'),
  isin: Str,
  date: Str.describe('ÅÅÅÅ-MM-DD. Kapitalanrop/utdelning: förfallodag/likviddag (inte brevdatum). Affär: affärsdag. NAV/innehav: värderingsdag.'),
  settle_date: Str.describe('Likviddag ÅÅÅÅ-MM-DD om angiven'),
  currency: Str,
  quantity: Num.describe('Antal andelar/aktier (köp, sälj, innehav)'),
  price: Num.describe('Kurs/NAV-kurs per andel eller utdelning per aktie'),
  amount: Num.describe('Belopp: anropat totalbelopp, utdelat belopp, likvidbelopp exkl. avgift, NAV, bruttoutdelning. Alltid positivt.'),
  fee: Num.describe('Courtage/avgift/källskatt. Kapitalanrop: förvaltningsavgifter och kostnader som ingår i anropet men inte påverkar NAV.'),
  commitment_total: Num.describe('CAS: investerarens totala åtagande'),
  paid_in_total: Num.describe('CAS: ackumulerat inbetalt kapital'),
  unfunded: Num.describe('CAS: kvarvarande outnyttjat åtagande'),
  distributed_total: Num.describe('CAS: ackumulerat utdelat'),
  line_items: z.array(z.object({
    description: z.string(),
    amount: z.number().describe('Positivt belopp'),
    affects_nav: z.boolean().describe('true om delposten ändrar fondandelens värde (investering, återbetalning av kapital, realiserad vinst); false för förvaltningsavgift, kostnader, carry, källskatt'),
    page: z.number().int().nullable(),
  })).describe('Alla atomära delposter för kapitalanrop/utdelning. Inga summarader.'),
  note: z.string().nullable().describe('Kort kommentar på svenska om något är oklart'),
});

export const Extraction = z.object({
  document_type: z.enum(DOC_TYPES),
  summary: z.string().describe('En mening på svenska om vad dokumentet är'),
  issuer: Str.describe('Avsändare: GP/fondbolag/bank/förvaltare (varumärkesnamn, inte juridisk enhet)'),
  investor_label: Str.describe('Investerarens namn ORDAGRANT som det står på raden/kolumnen värdena hämtades från'),
  items: z.array(Item),
  warnings: z.array(z.string()).describe('Saker på svenska som granskaren bör dubbelkolla'),
});
export type ExtractionT = z.infer<typeof Extraction>;
export type ExtractedItem = z.infer<typeof Item>;

export function aiStatus() {
  if (process.env.INNEHAV_AI_MOCK) return { enabled: true, model: 'demo (förinspelade svar)', mock: true };
  return { enabled: !!process.env.ANTHROPIC_API_KEY, model: AI_MODEL, mock: false };
}

function buildPrompt(ctx: { entities: string[]; instruments: string[]; rules: { issuer: string; instructions: string }[]; hint?: string; filename: string }) {
  return `Du tolkar ett underlag till ett portföljsystem för en institutionell investerare. Systemet hanterar
direktägda aktier, aktie-/räntefonder och private equity-fonder. Dina förslag granskas och godkänns manuellt
av en människa, så det är viktigare att vara ärlig om osäkerhet än att gissa.

## Investerarens juridiska enheter
${ctx.entities.map((e) => `- ${e}`).join('\n')}
Hämta alltid värden för någon av dessa enheter. Om dokumentet har en tabell med flera investerare: använd rätt
rad/kolumn och ange dess etikett ordagrant i investor_label. Finns flera av våra enheter i samma dokument: en post per enhet.

## Kända instrument (använd exakt namn om dokumentet gäller något av dem)
${ctx.instruments.map((i) => `- ${i}`).join('\n')}

## Regler
- Ett dokument kan innehålla flera poster (t.ex. flera fonder, eller både NAV och innehav). Returnera en post per händelse.
- Kapitalkontoutdrag (CAS): skapa en NAV-post (värde EFTER carried interest, investerarens andel) och fyll
  commitment_total, paid_in_total, unfunded, distributed_total om de finns – de används för avstämning.
- Kapitalanrop: amount = totalt anropat belopp som ska betalas; fee = den del som är avgifter/kostnader (påverkar inte NAV).
  Lista alla delposter i line_items.
- Utdelning från PE-fond: amount = totalt belopp till investeraren; delposter i line_items.
- Avräkningsnota fond/aktie: BUY/SELL med antal, kurs, likvidbelopp (amount, exkl. avgift), avgift och affärsdag.
- Innehavsbesked/depåbesked: en HOLDING-post per instrument (antal per datum) och en PRICE-post om kurs anges.
- Belopp är alltid positiva. Parenteser betyder negativt i källan – ange beloppet positivt och förklara i note.
- Tal: tolka tusentalsavgränsare och decimaltecken korrekt (1.234.567,89 och 1,234,567.89 är samma tal).
- Datum alltid ÅÅÅÅ-MM-DD. Valuta som ISO-kod.
- Varje fält: value (null om det inte finns), confidence, page och quote (ordagrant utdrag). Hitta aldrig på värden.
- confidence 'high' endast när värdet står uttryckligen; 'medium' om du räknat ut eller valt mellan alternativ; 'low' annars.
${ctx.rules.length ? `\n## Avsändarspecifika regler (gäller ENDAST dokument från respektive avsändare, har företräde)\n${ctx.rules.map((r) => `### ${r.issuer}\n${r.instructions}`).join('\n\n')}\n` : ''}
${ctx.hint ? `\n## Instruktion från granskaren för denna tolkning (högsta prioritet)\n${ctx.hint}\n` : ''}
Filnamn (endast som ledtråd): ${ctx.filename}`;
}

export async function extractDocument(
  file: Buffer, mime: string, sha256: string,
  ctx: { entities: string[]; instruments: string[]; rules: { issuer: string; instructions: string }[]; hint?: string; filename: string },
): Promise<{ extraction: ExtractionT; model: string }> {
  const mock = process.env.INNEHAV_AI_MOCK;
  if (mock) {
    const f = join(mock, `${sha256}.json`);
    if (!existsSync(f)) throw new Error('Demoläge: inget förinspelat svar för detta dokument');
    return { extraction: Extraction.parse(JSON.parse(readFileSync(f, 'utf8'))), model: 'demo' };
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('AI-tolkning är inte aktiverad (ANTHROPIC_API_KEY saknas)');

  const client = new Anthropic();
  const data = file.toString('base64');
  const source = mime === 'application/pdf'
    ? ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } } as const)
    : ({ type: 'image', source: { type: 'base64', media_type: mime as 'image/png' | 'image/jpeg', data } } as const);

  const response = await client.beta.messages.parse({
    model: AI_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: betaZodOutputFormat(Extraction) },
    messages: [{ role: 'user', content: [source, { type: 'text', text: buildPrompt(ctx) }] }],
  });
  if (response.stop_reason === 'refusal') throw new Error('AI-tjänsten avböjde att tolka dokumentet');
  if (response.stop_reason === 'max_tokens') throw new Error('Dokumentet var för stort för att tolkas i ett svep');
  if (!response.parsed_output) throw new Error('AI-svaret kunde inte tolkas');
  return { extraction: response.parsed_output, model: response.model };
}

export function describeAiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Ogiltig API-nyckel för AI-tjänsten';
  if (e instanceof Anthropic.RateLimitError) return 'AI-tjänsten är tillfälligt överbelastad – försök igen om en stund';
  if (e instanceof Anthropic.BadRequestError) return `AI-tjänsten kunde inte läsa dokumentet: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Fel från AI-tjänsten (${e.status})`;
  return (e as Error)?.message ?? String(e);
}
