import request from 'supertest';
import app from '../src/app';

describe('GET / Status & Docs Landing Page', () => {
  it('should return 200 OK with HTML content-type', async () => {
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('should contain the service name PagePulse', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('PagePulse');
  });

  it('should contain a copyable curl example of POST /api/audit', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('curl -X POST');
    expect(res.text).toContain('/api/audit');
  });

  it('should contain exact required footer credit line and hyperlink', async () => {
    const res = await request(app).get('/');

    // Hard submission requirement verification
    expect(res.text).toContain('Built for <a href="https://digitalheroesco.com" target="_blank" rel="noopener noreferrer">Digital Heroes Training Task</a>');
    expect(res.text).toContain('https://digitalheroesco.com');
    expect(res.text).toContain('Built for');
    expect(res.text).toContain('Digital Heroes Training Task');
  });
});
