const request = require('supertest');
const app = require('../server');

describe('Keepsake Application Health, Frontend & API Validation', () => {
  test('GET /health returns 200 healthy status and memory telemetry', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.service).toBe('keepsake-photo-journal');
    expect(typeof res.body.memoryUsageMB).toBe('number');
  });

  test('GET / serves the HTML frontend with 200 OK', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text.toLowerCase()).toContain('<!doctype html>');
  });

  test('POST /api/photos/presigned-url rejects missing file metadata cleanly', async () => {
    const res = await request(app)
      .post('/api/photos/presigned-url')
      .send({});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
