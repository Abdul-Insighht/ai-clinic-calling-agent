import { describe, expect, it } from 'vitest';
import { createDemoUsers, InMemoryUserRepository } from '../../src/api/auth.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { demoBusiness } from '../../src/business/demo-business.ts';
import { NORTHSTAR_BUSINESS_ID } from '../../src/db/seed.ts';
import { InMemoryAppointmentRepository } from '../../src/repositories/appointment-repository.ts';
import { InMemoryBusinessRepository } from '../../src/repositories/business-repository.ts';
import { InMemoryLeadRepository } from '../../src/repositories/lead-repository.ts';
import { BusinessService } from '../../src/services/business-service.ts';
import { NoopCalendarAdapter } from '../../src/services/google-calendar-adapter.ts';

describe('Phase 6 — Single-business authentication, RBAC, and LiveKit token security', () => {
  async function createServer() {
    return buildApiServer({
      jwtSecret: 'test-jwt-secret',
      livekitUrl: 'wss://test.livekit.cloud',
      livekitApiKey: 'test-lk-key',
      livekitApiSecret: 'test-lk-secret-that-is-long-enough-32chars',
      userRepository: new InMemoryUserRepository(createDemoUsers()),
      businessService: new BusinessService(new InMemoryBusinessRepository([demoBusiness])),
      appointmentRepository: new InMemoryAppointmentRepository(),
      leadRepository: new InMemoryLeadRepository(),
      calendarAdapter: new NoopCalendarAdapter(),
    });
  }

  it('rejects unauthenticated and invalid-token requests with 401', async () => {
    const app = await createServer();

    const noAuth = await app.inject({ method: 'GET', url: '/api/v1/business' });
    expect(noAuth.statusCode).toBe(401);

    const badToken = await app.inject({
      method: 'GET',
      url: '/api/v1/business',
      headers: { authorization: 'Bearer invalid.jwt.token' },
    });
    expect(badToken.statusCode).toBe(401);

    await app.close();
  });

  it('enforces RBAC on admin-only team endpoints and mints LiveKit room tokens server-side', async () => {
    const app = await createServer();

    const staffLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'staff@northstar.example', password: 'NorthStarStaff123!' },
    });
    expect(staffLogin.statusCode).toBe(200);
    const staffToken = (staffLogin.json() as { accessToken: string }).accessToken;

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@northstar.example', password: 'NorthStarAdmin123!' },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminToken = (adminLogin.json() as { accessToken: string }).accessToken;

    // Staff is blocked from /api/v1/team
    const staffTeam = await app.inject({
      method: 'GET',
      url: '/api/v1/team',
      headers: { authorization: `Bearer ${staffToken}` },
    });
    expect(staffTeam.statusCode).toBe(403);

    // Admin succeeds
    const adminTeam = await app.inject({
      method: 'GET',
      url: '/api/v1/team',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminTeam.statusCode).toBe(200);
    const members = (adminTeam.json() as { members: Array<{ email: string }> }).members;
    expect(members.map((m) => m.email)).toEqual([
      'admin@northstar.example',
      'staff@northstar.example',
    ]);

    // LiveKit token minting binds the configured businessId
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/livekit/token',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { participantName: 'Admin Tester' },
    });
    expect(tokenRes.statusCode).toBe(200);
    const tokenBody = tokenRes.json() as { token: string; roomMetadata: string };
    expect(tokenBody.token.length).toBeGreaterThan(20);
    expect(JSON.parse(tokenBody.roomMetadata)).toEqual({ businessId: NORTHSTAR_BUSINESS_ID });

    await app.close();
  });
});
