/**
 * Supabase (free tier) room store — a thin wrapper over the PostgREST HTTP
 * API. No SDK, no build step: plain `fetch` plus polling, which is plenty for
 * a turn-based game and works from any static host.
 *
 * Three tables are used (see online/README.md for the SQL):
 *   rooms  — one row per room: the board, who created it, the host's side,
 *            and the current game number (bumped by “再来一局”).
 *   moves  — the ordered move list of one game: (room, game, move_index).
 *   events — undo requests and their answers.
 */

export function createSupabaseStore({ url, key, room, fetchImpl = globalThis.fetch }) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  const apiKey = String(key || '').trim();
  const code = String(room || '').trim().toUpperCase();
  if (!base || !apiKey) throw new Error('需要 Supabase 项目 URL 和 anon key');
  if (!code) throw new Error('缺少房间号');
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持 fetch');

  const headers = { apikey: apiKey, 'Content-Type': 'application/json' };
  // Legacy anon keys are JWTs; newer publishable keys go in `apikey` only.
  if (apiKey.startsWith('eyJ')) headers.Authorization = `Bearer ${apiKey}`;

  const rooms = `${base}/rest/v1/rooms`;
  const moves = `${base}/rest/v1/moves`;
  const events = `${base}/rest/v1/events`;
  const roomFilter = `room=eq.${encodeURIComponent(code)}`;

  const detail = async (response) => {
    try {
      const text = (await response.text()).slice(0, 200);
      return text ? ` · ${text}` : '';
    } catch (error) {
      return '';
    }
  };
  const failure = async (response, action) => ({ ok: false, reason: `${action}失败：HTTP ${response.status}${await detail(response)}` });

  return {
    code,
    label: 'Supabase 云端房间',
    detail: `${base} · 房间 ${code}`,

    /** The room row, or `null` when the code does not exist. */
    async getRoom() {
      const response = await fetchImpl(`${rooms}?code=eq.${encodeURIComponent(code)}&select=*`, { headers });
      if (!response.ok) throw new Error(`读取房间失败：HTTP ${response.status}${await detail(response)}`);
      const rows = await response.json();
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },

    async createRoom({ board, hostToken, hostSide }) {
      const response = await fetchImpl(rooms, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify([
          { code, board, host_token: hostToken, host_side: hostSide, game: 1 },
        ]),
      });
      if (response.ok) return { ok: true };
      if (response.status === 409) return { ok: false, reason: `房间号 ${code} 已被占用，换一个再试` };
      return failure(response, '创建房间');
    },

    /** Host-only: change the game number / sides (rematch). */
    async updateRoom(patch) {
      const response = await fetchImpl(`${rooms}?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
      });
      return response.ok ? { ok: true } : failure(response, '更新房间');
    },

    async listMoves(game) {
      const response = await fetchImpl(
        `${moves}?${roomFilter}&game=eq.${Number(game)}&select=move_index,side,x,y&order=move_index.asc`,
        { headers },
      );
      if (!response.ok) throw new Error(`读取着法失败：HTTP ${response.status}${await detail(response)}`);
      const rows = await response.json();
      return Array.isArray(rows) ? rows : [];
    },

    async appendMove({ game, moveIndex, side, x, y }) {
      const response = await fetchImpl(moves, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify([{ room: code, game, move_index: moveIndex, side, x, y }]),
      });
      if (response.ok) return { ok: true };
      if (response.status === 409) return { ok: false, reason: '这一手已被占用（对手刚落下），正在重新同步' };
      return failure(response, '写入着法');
    },

    /** Drop the tail of the move list; used when an undo is approved. */
    async deleteMovesFrom(game, fromIndex) {
      const response = await fetchImpl(
        `${moves}?${roomFilter}&game=eq.${Number(game)}&move_index=gte.${Number(fromIndex)}`,
        { method: 'DELETE', headers },
      );
      return response.ok ? { ok: true } : failure(response, '撤销着法');
    },

    async listEvents(game) {
      const response = await fetchImpl(
        `${events}?${roomFilter}&game=eq.${Number(game)}&select=id,kind,side,target&order=id.desc&limit=8`,
        { headers },
      );
      if (!response.ok) throw new Error(`读取消极事件失败：HTTP ${response.status}${await detail(response)}`);
      const rows = await response.json();
      return Array.isArray(rows) ? rows.reverse() : [];
    },

    async appendEvent({ game, kind, side, target = null }) {
      const response = await fetchImpl(events, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify([{ room: code, game, kind, side, target }]),
      });
      return response.ok ? { ok: true } : failure(response, '写入请求');
    },

    /** Host-only reset: wipe the room history and start again from game 1. */
    async resetRoom() {
      const cleared = await Promise.all([
        fetchImpl(`${moves}?${roomFilter}`, { method: 'DELETE', headers }),
        fetchImpl(`${events}?${roomFilter}`, { method: 'DELETE', headers }),
      ]);
      const bad = cleared.find((response) => !response.ok);
      if (bad) return failure(bad, '清空房间');
      return this.updateRoom({ game: 1 });
    },
  };
}
