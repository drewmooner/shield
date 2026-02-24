/**
 * Baileys auth state stored in PostgreSQL.
 * Sessions persist across restarts; users don't need to scan QR again.
 * Use when DATABASE_URL is set.
 */
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

const SESSION_NAME = 'shield-session';

export async function usePostgresAuthState(pool, sessionName = SESSION_NAME) {
  const readData = async (key) => {
    if (key === 'creds.json') {
      const client = await pool.connect();
      try {
        const r = await client.query('SELECT data FROM auth_creds WHERE session_name = $1', [sessionName]);
        if (!r.rows[0]?.data) return null;
        return JSON.parse(JSON.stringify(r.rows[0].data), BufferJSON.reviver);
      } finally {
        client.release();
      }
    }
    const keyName = key.replace('.json', '');
    const client = await pool.connect();
    try {
      const r = await client.query(
        'SELECT data FROM auth_keys WHERE session_name = $1 AND key_name = $2',
        [sessionName, keyName]
      );
      if (!r.rows[0]?.data) return null;
      let value = JSON.parse(JSON.stringify(r.rows[0].data), BufferJSON.reviver);
      if (keyName.startsWith('app-state-sync-key-') && value) {
        value = proto.Message.AppStateSyncKeyData.fromObject(value);
      }
      return value;
    } finally {
      client.release();
    }
  };

  const writeData = async (key, data) => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    const parsed = JSON.parse(json);
    if (key === 'creds.json') {
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO auth_creds (session_name, data) VALUES ($1, $2::jsonb)
           ON CONFLICT (session_name) DO UPDATE SET data = $2::jsonb`,
          [sessionName, JSON.stringify(parsed)]
        );
      } finally {
        client.release();
      }
      return;
    }
    const keyName = key.replace('.json', '');
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO auth_keys (session_name, key_name, data) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (session_name, key_name) DO UPDATE SET data = $3::jsonb`,
        [sessionName, keyName, JSON.stringify(parsed)]
      );
    } finally {
      client.release();
    }
  };

  const removeData = async (key) => {
    if (key === 'creds.json') {
      const client = await pool.connect();
      try {
        await client.query('DELETE FROM auth_creds WHERE session_name = $1', [sessionName]);
      } finally {
        client.release();
      }
      return;
    }
    const keyName = key.replace('.json', '');
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM auth_keys WHERE session_name = $1 AND key_name = $2', [
        sessionName,
        keyName,
      ]);
    } finally {
      client.release();
    }
  };

  const creds = (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              const key = `${type}-${id}.json`;
              const value = await readData(key);
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}.json`;
              if (value) await writeData(key, value);
              else await removeData(key);
            }
          }
        },
      },
    },
    saveCreds: async () => {
      return writeData('creds.json', creds);
    },
  };
}
