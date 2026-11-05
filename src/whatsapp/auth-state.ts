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
// A write for a row that has been deleted changes nothing and calls onRowGone.
// It must not raise: Baileys retries a failed write 10 times, 3 seconds apart,
// while everything else on that socket waits, and the row isn't coming back.
export async function usePrismaAuthState(
  prisma: PrismaService,
  phoneNumberId: string,
  onRowGone?: () => void,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const read = async (key: string): Promise<unknown> => {
    const row = await prisma.whatsAppAuth.findUnique({
      where: { phoneNumberId_key: { phoneNumberId, key } },
    });
    return row ? JSON.parse(row.value, BufferJSON.reviver) : null;
  };

  // One statement, however many keys there are: one round trip, and atomic
  // without a transaction (BEGIN and COMMIT would be two more trips). Right
  // after a scan Baileys stores 812 pre-keys and only reports the connection
  // open once they're saved; one upsert each, at ~190ms a round trip, kept a
  // freshly linked number "pending" for over two minutes. Every message
  // received and every reply sent also saves keys here before it goes on, so
  // each trip saved is felt per reply.
  const write = async (keys: string[], values: string[], removed: string[]) => {
    const written = await prisma.$executeRaw`
      WITH removed AS (
        DELETE FROM whatsapp_auth
        WHERE phone_number_id = ${phoneNumberId}
          AND key = ANY(${removed}::text[])
      )
      INSERT INTO whatsapp_auth (phone_number_id, key, value, updated_at)
      SELECT ${phoneNumberId}, k, v, now()
      FROM unnest(${keys}::text[], ${values}::text[]) AS u(k, v)
      WHERE EXISTS (SELECT 1 FROM phone_numbers WHERE id = ${phoneNumberId})
      ON CONFLICT (phone_number_id, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    if (written === 0 && keys.length > 0) onRowGone?.();
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
          await write(keys, values, removed);
        },
      },
    },
    saveCreds: async () => {
      await write(['creds'], [JSON.stringify(creds, BufferJSON.replacer)], []);
    },
  };
}
