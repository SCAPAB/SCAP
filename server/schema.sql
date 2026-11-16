-- Innehav – datamodell
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','editor','viewer')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Juridiska enheter (bolag, stiftelser, pensionskassor …) som äger innehaven
CREATE TABLE IF NOT EXISTS entities (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  org_nr     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Värdepapper. type: EQUITY = noterad aktie, FUND = aktie-/räntefond, PE_FUND = private equity-fond
CREATE TABLE IF NOT EXISTS instruments (
  id          INTEGER PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('EQUITY','FUND','PE_FUND')),
  name        TEXT NOT NULL,
  isin        TEXT UNIQUE,
  ticker      TEXT,
  currency    TEXT NOT NULL,
  country     TEXT,            -- ISO 3166 alpha-2 (emittent/domicil)
  region      TEXT,            -- Norden, Europa, Nordamerika, Asien, Global, Tillväxtmarknader
  sector      TEXT,            -- bransch (aktier) / inriktning (fonder)
  fund_category TEXT,          -- Aktiefond, Räntefond, Blandfond, Alternativ
  manager     TEXT,            -- fondbolag / GP
  strategy    TEXT,            -- PE: Buyout, Venture, Growth, Infrastruktur …
  vintage     INTEGER,         -- PE: vintage year
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Transaktioner. Belopp anges i instrumentets valuta. fx_rate = SEK per 1 enhet valuta på affärsdagen.
-- Noterat (EQUITY/FUND): BUY, SELL, DIVIDEND, FEE
-- PE_FUND: COMMITMENT, CALL (kapitalanrop), DISTRIBUTION (utdelning/återbetalning), FEE (avgift utanför åtagandet)
CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT, -- id återanvänds aldrig: attest och ändringshistorik följer id:t (F9)
  entity_id     INTEGER NOT NULL REFERENCES entities(id),
  instrument_id INTEGER NOT NULL REFERENCES instruments(id),
  type          TEXT NOT NULL CHECK (type IN ('BUY','SELL','DIVIDEND','FEE','COMMITMENT','CALL','DISTRIBUTION')),
  trade_date    TEXT NOT NULL,
  settle_date   TEXT,
  quantity      REAL NOT NULL DEFAULT 0,  -- antal (BUY/SELL), annars 0
  price         REAL NOT NULL DEFAULT 0,  -- kurs per andel (BUY/SELL)
  amount        REAL NOT NULL,            -- bruttobelopp i instrumentvaluta, alltid positivt
  fee           REAL NOT NULL DEFAULT 0,  -- courtage/avgift i instrumentvaluta
  fx_rate       REAL NOT NULL DEFAULT 1,
  note          TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_tx_instr ON transactions(instrument_id, trade_date);
CREATE INDEX IF NOT EXISTS ix_tx_entity ON transactions(entity_id, trade_date);

-- Kurser/NAV-kurser för noterade instrument och fonder
CREATE TABLE IF NOT EXISTS prices (
  instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  price         REAL NOT NULL,
  source        TEXT,
  PRIMARY KEY (instrument_id, date)
);

-- Rapporterat andelsvärde (NAV) i PE-fond per juridisk enhet, i fondens valuta
CREATE TABLE IF NOT EXISTS pe_valuations (
  entity_id     INTEGER NOT NULL REFERENCES entities(id),
  instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  nav           REAL NOT NULL,
  source        TEXT,
  PRIMARY KEY (entity_id, instrument_id, date)
);

-- Valutakurser: SEK per 1 enhet valuta
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT NOT NULL,
  date     TEXT NOT NULL,
  rate     REAL NOT NULL,
  PRIMARY KEY (currency, date)
);

-- Spårbarhet: alla ändringar loggas
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  action     TEXT NOT NULL,
  object     TEXT NOT NULL,
  object_id  TEXT,
  details    TEXT
);

-- ---------------------------------------------------------------------------
-- Dokumentinkorg: uppladdade underlag, AI-förslag och manuellt godkännande
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  sha256       TEXT NOT NULL UNIQUE,
  size         INTEGER NOT NULL,
  pages        INTEGER,
  status       TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','review','done','error','manual')),
  doc_type     TEXT,
  issuer       TEXT,
  investor_label TEXT,
  summary      TEXT,
  extraction   TEXT,      -- rått AI-svar (JSON) för spårbarhet
  ai_model     TEXT,
  error        TEXT,
  uploaded_by  INTEGER REFERENCES users(id),
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

-- Ett förslag = en post som ska in i systemet (transaktion, NAV, kurs eller avstämning)
CREATE TABLE IF NOT EXISTS proposals (
  id            INTEGER PRIMARY KEY,
  document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('BUY','SELL','DIVIDEND','FEE','COMMITMENT','CALL','DISTRIBUTION','NAV','PRICE','HOLDING')),
  origin        TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai','manual')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  entity_id     INTEGER REFERENCES entities(id),
  instrument_id INTEGER REFERENCES instruments(id),
  match         TEXT,     -- JSON: hur enhet/instrument matchades
  fields        TEXT NOT NULL, -- JSON: { fält: { value, ai_value, confidence, page, quote, edited, confirmed } }
  line_items    TEXT,     -- JSON: delposter (kapitalanrop/utdelningar)
  result_ref    TEXT,     -- vad som skapades vid godkännande, t.ex. "transaction:412"
  decided_by    INTEGER REFERENCES users(id),
  decided_at    TEXT,
  comment       TEXT
);
CREATE INDEX IF NOT EXISTS ix_prop_doc ON proposals(document_id, seq);

-- Avsändarspecifika tolkningsregler (lärs upp av användarna)
CREATE TABLE IF NOT EXISTS extraction_rules (
  id           INTEGER PRIMARY KEY,
  issuer       TEXT NOT NULL,
  instructions TEXT NOT NULL,
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Strategisk allokering (policyportfölj) per tillgångsslag
CREATE TABLE IF NOT EXISTS policy_targets (
  asset_class TEXT PRIMARY KEY,
  target      REAL NOT NULL,   -- andel 0–1
  min         REAL NOT NULL,
  max         REAL NOT NULL
);

-- Inlärda namn: hur GP/fondbolag/banker benämner våra instrument och enheter i sina dokument
CREATE TABLE IF NOT EXISTS aliases (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('instrument','entity')),
  alias      TEXT NOT NULL,          -- normaliserad text
  raw        TEXT NOT NULL,          -- som det stod i dokumentet
  issuer     TEXT,                   -- avsändare (GP/bank) där aliaset gäller, NULL = alla
  target_id  INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, alias, issuer)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Logg över hämtningar från Morningstar
CREATE TABLE IF NOT EXISTS ms_sync_log (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id),
  kind    TEXT NOT NULL,
  ok      INTEGER NOT NULL,
  summary TEXT,
  details TEXT
);

-- Ändringsbegäran för en attesterad transaktion (fyra ögon-principen): ändringen genomförs först när
-- en annan användare än den som begärde den har attesterat. payload = de validerade nya värdena (update).
CREATE TABLE IF NOT EXISTS change_requests (
  id             INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL,          -- ingen främmande nyckel: begäran finns kvar för spårbarhet efter ett borttag
  action         TEXT NOT NULL CHECK (action IN ('update','delete')),
  payload        TEXT,
  before_value   TEXT,                      -- transaktionen när begäran skapades (JSON), visas i stället för den aktuella raden
  requested_by   INTEGER REFERENCES users(id),
  requested_at   TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by     INTEGER REFERENCES users(id),
  decided_at     TEXT,
  comment        TEXT
);
CREATE INDEX IF NOT EXISTS ix_change_tx ON change_requests(transaction_id, status);
