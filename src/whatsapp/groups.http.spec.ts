import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';

// The routes themselves: a group id has an "@" in it, which the dashboard sends
// encoded, and which has to arrive whole.

jest.mock('./whatsapp.service', () => ({ WhatsAppService: class {} }));
jest.mock('../auth/auth.guard', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createParamDecorator } = require('@nestjs/common') as {
    createParamDecorator: typeof import('@nestjs/common').createParamDecorator;
  };
  return {
    ClerkAuthGuard: class {},
    CurrentUser: createParamDecorator(() => ({ id: 'user1' })),
  };
});

const GROUP = '120363000000000001@g.us';

describe('group routes', () => {
  let app: INestApplication;
  const setGroupAi = jest.fn((_user, _id, jid: string, on: boolean) =>
    Promise.resolve({ jid, ai_enabled: on }),
  );
  const listGroups = jest.fn(() =>
    Promise.resolve({ chat_agent: null, groups: [] }),
  );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WhatsAppController],
      providers: [
        { provide: WhatsAppService, useValue: { setGroupAi, listGroups } },
      ],
    })
      .overrideGuard(ClerkAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  const patch = (jid: string, body: object) =>
    request(app.getHttpServer() as never)
      .patch(`/v1/phone-number/num1/groups/${encodeURIComponent(jid)}`)
      .send(body);

  it('lists the groups', async () => {
    await request(app.getHttpServer() as never)
      .get('/v1/phone-number/num1/groups')
      .expect(200);
    expect(listGroups).toHaveBeenCalledTimes(1);
  });

  it('gets the group id through encoded', async () => {
    const { body } = (await patch(GROUP, { ai_enabled: true }).expect(200)) as {
      body: { data: unknown };
    };
    expect(body.data).toEqual({ jid: GROUP, ai_enabled: true });
    expect(setGroupAi.mock.calls[0].slice(1)).toEqual(['num1', GROUP, true]);
  });

  it('refuses anything that is not a group, or not true or false', async () => {
    await patch('8801711111111@s.whatsapp.net', { ai_enabled: true }).expect(
      400,
    );
    await patch(GROUP, { ai_enabled: 'yes' }).expect(400);
    await patch(GROUP, {}).expect(400);
    expect(setGroupAi).not.toHaveBeenCalled();
  });
});
