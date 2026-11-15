import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './api.ts';
import { HttpError } from './auth.ts';
import { ensureSetup } from './setup.ts';

ensureSetup();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Okänd resurs' }));

// Produktionsläge: servera byggd klient
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  const msg = (err as Error)?.message ?? String(err);
  if (/UNIQUE constraint/.test(msg)) return res.status(409).json({ error: 'Posten finns redan' });
  console.error(err);
  res.status(500).json({ error: 'Internt fel' });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => console.log(`Innehav API lyssnar på http://localhost:${port}`));
