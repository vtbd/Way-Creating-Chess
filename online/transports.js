/**
 * Move transports for the online test build.
 *
 * A transport is deliberately tiny: it can read the ordered move list of a
 * room and append one move. Both implementations below are swappable, so the
 * same page works offline (browser tabs) and online (Supabase REST).
 *
 * Interface:
 *   list()            -> [{move_index, side, x, y}, ...]
 *   append(move)      -> {ok: true} | {ok: false, reason}
 *   clear()           -> {ok, reason}
 */

const LOCAL_PREFIX = 'wcc-online-room-';

/**
 * Same-browser transport: rooms live in `localStorage`, so two tabs (or two
 * windows) of the same browser can play against each other with no account and
 * no network. Handy to verify the whole flow before touching a backend.
 */
export function createLocalTransport(room, { storage = globalThis.localStorage } = {}) {
  const key = `${LOCAL_PREFIX}${room}`;
  const readAll = () => {
    try {
      const raw = storage.getItem(key);
      const rows = raw ? JSON.parse(raw) : [];
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      return [];
    }
  };
  return {
    label: '本地标签页测试',
    detail: `浏览器本地存储 · ${key}`,
    async list() {
      return readAll();
    },
    async append(move) {
      const rows = readAll();
      if (rows.some((row) => Number(row.move_index) === Number(move.move_index))) {
        return { ok: false, reason: '这一手已被占用（对手刚落下），正在重新同步' };
      }
      rows.push({ ...move });
      rows.sort((a, b) => Number(a.move_index) - Number(b.move_index));
      try {
        storage.setItem(key, JSON.stringify(rows));
      } catch (error) {
        return { ok: false, reason: `写入本地存储失败：${error.message}` };
      }
      return { ok: true };
    },
    async clear() {
      try {
        storage.removeItem(key);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    },
    close() {},
  };
}

/**
 * Supabase (free tier) transport over the PostgREST HTTP API.
 *
 * No SDK and no build step: two `fetch` calls and polling. For a turn-based
 * game a ~1 second poll is plenty, and plain HTTPS works everywhere.
 */
export function createSupabaseTransport({ url, key, room, fetchImpl = globalThis.fetch }) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  const apiKey = String(key || '').trim();
  if (!base || !apiKey) throw new Error('需要 Supabase 项目 URL 和 anon key');
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持 fetch');

  const headers = { apikey: apiKey, 'Content-Type': 'application/json' };
  // Legacy anon keys are JWTs; newer publishable keys go in `apikey` only.
  if (apiKey.startsWith('eyJ')) headers.Authorization = `Bearer ${apiKey}`;

  const table = `${base}/rest/v1/moves`;
  const roomFilter = `room=eq.${encodeURIComponent(room)}`;

  const describeError = async (response) => {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 200);
    } catch (error) {
      detail = '';
    }
    return `HTTP ${response.status}${detail ? ` · ${detail}` : ''}`;
  };

  return {
    label: 'Supabase 云端房间',
    detail: `${base} · moves.room = ${room}`,
    async list() {
      const response = await fetchImpl(
        `${table}?${roomFilter}&select=move_index,side,x,y&order=move_index.asc`,
        { headers },
      );
      if (!response.ok) throw new Error(`读取着法失败：${await describeError(response)}`);
      const rows = await response.json();
      return Array.isArray(rows) ? rows : [];
    },
    async append(move) {
      const response = await fetchImpl(table, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify([{ room, move_index: move.move_index, side: move.side, x: move.x, y: move.y }]),
      });
      if (response.ok) return { ok: true };
      if (response.status === 409) {
        return { ok: false, reason: '这一手已被占用（对手刚落下），正在重新同步' };
      }
      return { ok: false, reason: `写入着法失败：${await describeError(response)}` };
    },
    async clear() {
      const response = await fetchImpl(`${table}?${roomFilter}`, { method: 'DELETE', headers });
      return response.ok ? { ok: true } : { ok: false, reason: `清空失败：${await describeError(response)}` };
    },
    close() {},
  };
}
