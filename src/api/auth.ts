import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { getDbPool } from '../db/client.ts';
import { NORTHSTAR_BUSINESS_ID } from '../db/seed.ts';

export type UserRole = 'owner' | 'admin' | 'staff';

export type AuthUser = {
  id: string;
  businessId: string;
  email: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  passwordHash: string;
};

export type AuthClaims = {
  sub: string;
  businessId: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) {
    return false;
  }
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function signJwt(
  claims: Omit<AuthClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds = 3600,
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullClaims: AuthClaims = {
    ...claims,
    iat: now,
    exp: now + ttlSeconds,
  };
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify(fullClaims));
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

export function verifyJwt(token: string, secret: string): AuthClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) {
    return null;
  }

  const expectedSig = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as AuthClaims;
    const now = Math.floor(Date.now() / 1000);
    if (typeof parsed.exp !== 'number' || parsed.exp <= now) {
      return null;
    }
    if (!parsed.sub || !parsed.businessId || !parsed.role) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export interface UserRepository {
  findByEmail(email: string): Promise<AuthUser | null>;
  listByBusiness(businessId: string): Promise<Array<Omit<AuthUser, 'passwordHash'>>>;
}

export class PostgresUserRepository implements UserRepository {
  private readonly pool: Pool | undefined;

  constructor(pool?: Pool) {
    this.pool = pool;
  }

  async findByEmail(email: string): Promise<AuthUser | null> {
    const pool = this.pool ?? getDbPool();
    const result = await pool.query<{
      id: string;
      business_id: string;
      email: string;
      full_name: string;
      role: UserRole;
      is_active: boolean;
      password_hash: string;
    }>(
      `
      SELECT id, business_id, email, full_name, role, is_active, password_hash
      FROM aibitsol.users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
      `,
      [email.trim()],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      businessId: row.business_id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      isActive: row.is_active,
      passwordHash: row.password_hash,
    };
  }

  async listByBusiness(businessId: string): Promise<Array<Omit<AuthUser, 'passwordHash'>>> {
    const pool = this.pool ?? getDbPool();
    const result = await pool.query<{
      id: string;
      business_id: string;
      email: string;
      full_name: string;
      role: UserRole;
      is_active: boolean;
    }>(
      `
      SELECT id, business_id, email, full_name, role, is_active
      FROM aibitsol.users
      WHERE business_id = $1
      ORDER BY created_at ASC
      `,
      [businessId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      isActive: row.is_active,
    }));
  }
}

export class InMemoryUserRepository implements UserRepository {
  private readonly users: AuthUser[];

  constructor(users: AuthUser[]) {
    this.users = users;
  }

  async findByEmail(email: string): Promise<AuthUser | null> {
    const normalized = email.trim().toLowerCase();
    return this.users.find((u) => u.email.toLowerCase() === normalized) ?? null;
  }

  async listByBusiness(businessId: string): Promise<Array<Omit<AuthUser, 'passwordHash'>>> {
    return this.users
      .filter((u) => u.businessId === businessId)
      .map((u) => ({
        id: u.id,
        businessId: u.businessId,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        isActive: u.isActive,
      }));
  }
}

export function createDemoUsers(): AuthUser[] {
  return [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      businessId: NORTHSTAR_BUSINESS_ID,
      email: 'admin@northstar.example',
      fullName: 'NorthStar Admin',
      role: 'admin',
      isActive: true,
      passwordHash: hashPassword('NorthStarAdmin123!'),
    },
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      businessId: NORTHSTAR_BUSINESS_ID,
      email: 'staff@northstar.example',
      fullName: 'NorthStar Staff',
      role: 'staff',
      isActive: true,
      passwordHash: hashPassword('NorthStarStaff123!'),
    },
  ];
}
