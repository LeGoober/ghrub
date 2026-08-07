import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';

describe('M0 scaffold', () => {
  // createApp connects to a database now, so the app is built in a hook
  // rather than inline in the describe body.
  let app;
  beforeAll(async () => {
    app = await createApp();
  });

  it('GET /healthz returns 200 ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, app: 'ghrub' });
  });

  it('GET / renders the home page', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ghrub');
  });
});
