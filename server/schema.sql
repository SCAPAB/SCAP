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
  id            INTEGER PRIMARY KEY,
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
