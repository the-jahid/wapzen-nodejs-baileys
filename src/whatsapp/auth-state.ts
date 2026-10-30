import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  SignalDataTypeMap,
} from 'baileys';
import { PrismaService } from '../prisma/prisma.service';

// Baileys' useMultiFileAuthState, but each "file" is a whatsapp_auth row.
export async function usePrismaAuthState(
  prisma: PrismaService,
  phoneNumberId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const read = async (key: string): Promise<unknown> => {
    const row = await prisma.whatsAppAuth.findUnique({
      where: { phoneNumberId_key: { phoneNumberId, key } },
    });
    return row ? JSON.parse(row.value, BufferJSON.reviver) : null;
  };

  const upsert = (key: string, data: unknown) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    return prisma.whatsAppAuth.upsert({
      where: { phoneNumberId_key: { phoneNumberId, key } },
      create: { phoneNumberId, key, value },
      update: { value },
    });
  };

  const creds =
    ((await read('creds')) as AuthenticationCreds | null) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ) => {
          const rows = await prisma.whatsAppAuth.findMany({
            where: {
              phoneNumberId,
              key: { in: ids.map((id) => `${type}-${id}`) },
            },
          });
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const row of rows) {
            let value = JSON.parse(
              row.value,
              BufferJSON.reviver,
            ) as SignalDataTypeMap[T];
            if (type === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as object,
              ) as unknown as SignalDataTypeMap[T];
            }
            data[row.key.slice(type.length + 1)] = value;
          }
          return data;
        },
        // One statement, however many keys there are: one round trip, and
        // atomic without a transaction (BEGIN and COMMIT would be two more
        // trips). Right after a scan Baileys stores 812 pre-keys and only
        // reports the connection open once they're saved; one upsert each, at
        // ~190ms a round trip, kept a freshly linked number "pending" for over
        // two minutes. Every message received and every reply sent also saves
        // keys here before it goes on, so each trip saved is felt per reply.
        set: async (data) => {
          const keys: string[] = [];
          const values: string[] = [];
          const removed: string[] = [];
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              const key = `${type}-${id}`;
              if (value) {
                keys.push(key);
                values.push(JSON.stringify(value, BufferJSON.replacer));
              } else {
                removed.push(key);
              }
            }
          }
          if (keys.length === 0 && removed.length === 0) return;
          await prisma.$executeRaw`
            WITH removed AS (
              DELETE FROM whatsapp_auth
              WHERE phone_number_id = ${phoneNumberId}
                AND key = ANY(${removed}::text[])
            )
            INSERT INTO whatsapp_auth (phone_number_id, key, value, updated_at)
            SELECT ${phoneNumberId}, k, v, now()
            FROM unnest(${keys}::text[], ${values}::text[]) AS u(k, v)
            ON CONFLICT (phone_number_id, key)
            DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
        },
      },
    },
    saveCreds: async () => {
      await upsert('creds', creds);
    },
  };
}
