import { buildRequest } from './runner';
import {
  apiRequestErrors,
  normalizeApiRequest,
  parseApiRequest,
} from './tools.types';

const base = {
  url: 'https://api.example.com/hook',
  parameters: [
    { name: 'date', type: 'string', description: 'The day', required: true },
  ],
  body_fields: [
    { key: 'source', value: 'whatsapp', type: 'string' },
    { key: 'store_id', value: '42', type: 'number' },
    { key: 'live', value: 'true', type: 'boolean' },
  ],
};

const config = (extra: Record<string, unknown>) =>
  normalizeApiRequest(parseApiRequest({ ...base, ...extra }));

describe('buildRequest', () => {
  it('sends fixed fields typed, beside the arguments, in a JSON body', () => {
    const req = buildRequest(config({ method: 'POST' }), {
      date: '2026-11-03',
    });
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(req.body!)).toEqual({
      date: '2026-11-03',
      source: 'whatsapp',
      store_id: 42,
      live: true,
    });
  });

  it('encodes a form body when asked', () => {
    const req = buildRequest(config({ method: 'PATCH', body_type: 'form' }), {
      date: '2026-11-03',
    });
    expect(req.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(req.body).toBe(
      'date=2026-11-03&source=whatsapp&store_id=42&live=true',
    );
  });

  it('puts fixed fields in the query string on GET', () => {
    const req = buildRequest(config({ method: 'GET' }), { date: 'today' });
    expect(req.body).toBeUndefined();
    expect(req.url.search).toBe(
      '?date=today&source=whatsapp&store_id=42&live=true',
    );
  });

  it('runs a block stored before fixed fields existed', () => {
    const req = buildRequest(
      {
        method: 'POST',
        url: base.url,
        timeout_seconds: 20,
        async: false,
        headers: [],
        parameters: base.parameters,
      } as never,
      { date: 'today' },
    );
    expect(JSON.parse(req.body!)).toEqual({ date: 'today' });
  });
});

describe('apiRequestErrors', () => {
  const errorsFor = (extra: Record<string, unknown>) =>
    apiRequestErrors(parseApiRequest({ ...base, method: 'POST', ...extra }));

  it('accepts a valid block', () => {
    expect(errorsFor({})).toEqual([]);
  });

  it('refuses a fixed field named like a parameter', () => {
    const errors = errorsFor({
      body_fields: [{ key: 'date', value: 'x', type: 'string' }],
    });
    expect(errors.map((e) => e.field)).toEqual([
      'api_request.body_fields[0].key',
    ]);
  });

  it('refuses a number field that is not a number', () => {
    const errors = errorsFor({
      body_fields: [{ key: 'qty', value: 'two', type: 'number' }],
    });
    expect(errors.map((e) => e.field)).toEqual([
      'api_request.body_fields[0].value',
    ]);
  });

  it('refuses an unknown body type', () => {
    const errors = errorsFor({ body_type: 'xml' });
    expect(errors.map((e) => e.field)).toEqual(['api_request.body_type']);
  });

  it('refuses a header name Node would reject at send time', () => {
    const errors = errorsFor({
      headers: [{ key: 'API Key', value: 'secret' }],
    });
    expect(errors.map((e) => e.field)).toEqual(['api_request.headers[0].key']);
  });
});
