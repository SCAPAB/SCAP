import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { get, run, audit } from './db.ts';
import type { Me, Role } from '../shared/types.ts';

const COOKIE = 'innehav_session';
const SESSION_HOURS = 12;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: Me;
    }
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function login(req: Request, res: Response) {
  const { email, password } = req.body ?? {};
  const u = get<Me & { password_hash: string }>('SELECT * FROM users WHERE email = ?', String(email ?? ''));
  if (!u || !bcrypt.compareSync(String(password ?? ''), u.password_hash)) {
    audit(null, 'login_failed', 'user', null, { email });
    throw new HttpError(401, 'Fel e-postadress eller lösenord');
  }
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)', token, u.id, expires);
  audit(u.id, 'login', 'user', u.id);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_HOURS * 3600_000,
  });
  res.json({ id: u.id, email: u.email, name: u.name, role: u.role });
}

export function logout(req: Request, res: Response) {
  const t = req.cookies?.[COOKIE];
  if (t) run('DELETE FROM sessions WHERE token = ?', t);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const t = req.cookies?.[COOKIE];
  if (!t) throw new HttpError(401, 'Inte inloggad');
  const u = get<Me>(
    'SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?',
    t, new Date().toISOString(),
  );
  if (!u) throw new HttpError(401, 'Sessionen har gått ut');
  req.user = u;
  next();
}

const rank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
export const requireRole = (role: Role) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user || rank[req.user.role] < rank[role]) throw new HttpError(403, 'Behörighet saknas');
  next();
};

export const hashPassword = (pw: string) => bcrypt.hashSync(pw, 10);
