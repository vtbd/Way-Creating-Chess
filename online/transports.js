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
  const members = `${base}/rest/v1/members`;
  const roomFilter = `room=eq.${encodeURIComponent(code)}`;

  /** PostgREST reports a stale schema as PGRST204/PGRST205 (or raw PG codes). */
  const SCHEMA_HINT =
    '数据库结构不是最新的：请在 Supabase 的 SQL Editor 里重跑 online/README.md 第二步的整段 SQL（补齐 rooms.main_ms、rooms.move_ms、members.ready_game、members.ready_at），再执行一次 NOTIFY pgrst, \'reload schema\';';

  const readError = async (response) => {
    let text = '';
    try {
      text = (await response.text()) || '';
    } catch (error) {
      text = '';
    }
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = null;
    }
    const code = payload && payload.code;
    const stale = code === 'PGRST204' || code === 'PGRST205' || code === '42P01' || code === '42703';
    return { text: text.slice(0, 200), hint: stale ? SCHEMA_HINT : '' };
  };
  const detail = async (response) => {
    const { text } = await readError(response);
    return text ? ` · ${text}` : '';
  };
  const failure = async (response, action) => {
    const { text, hint } = await readError(response);
    const suffix = text ? ` · ${text}` : '';
    return { ok: false, reason: `${action}失败：HTTP ${response.status}${suffix}${hint ? `　→ ${hint}` : ''}` };
  };

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

    /**
     * The fields the poll actually needs. Leaving the board JSON and the host
     * token out keeps each poll small — important with a 0.7 s interval on the
     * free tier.
     */
    async getRoomState() {
      const response = await fetchImpl(
        `${rooms}?code=eq.${encodeURIComponent(code)}&select=code,game,host_side,main_ms,move_ms`,
        { headers },
      );
      if (!response.ok) throw new Error(`读取房间失败：HTTP ${response.status}${await detail(response)}`);
      const rows = await response.json();
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },

    async createRoom({ board, hostToken, hostSide, mainMs, moveMs }) {
      const response = await fetchImpl(rooms, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify([
          { code, board, host_token: hostToken, host_side: hostSide, game: 1, main_ms: mainMs, move_ms: moveMs },
        ]),
      });
      if (response.ok) {
        // The code was free, so any member rows left over from an earlier room
        // with the same code are stale: start from an empty roster.
        await fetchImpl(`${members}?${roomFilter}`, { method: 'DELETE', headers }).catch(() => null);
        return { ok: true };
      }
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
        `${moves}?${roomFilter}&game=eq.${Number(game)}&select=move_index,side,x,y,created_at&order=move_index.asc`,
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

    /** Host-only: delete the room itself, freeing the code for reuse. */
    async closeRoom() {
      const responses = await Promise.all([
        fetchImpl(`${moves}?${roomFilter}`, { method: 'DELETE', headers }),
        fetchImpl(`${events}?${roomFilter}`, { method: 'DELETE', headers }),
        fetchImpl(`${members}?${roomFilter}`, { method: 'DELETE', headers }),
        fetchImpl(`${rooms}?code=eq.${encodeURIComponent(code)}`, { method: 'DELETE', headers }),
      ]);
      const bad = responses.find((response) => !response.ok);
      return bad ? failure(bad, '关闭房间') : { ok: true };
    },

    /**
     * Everyone who has ever sat in this room, plus the server clock (taken
     * from the HTTP `Date` header) so staleness is judged against the
     * database's time rather than the local one.
     */
    async listMembers() {
      const response = await fetchImpl(
        `${members}?${roomFilter}&select=device,nickname,role,side,joined_at,last_seen,ready_game,ready_at&order=joined_at.asc`,
        { headers },
      );
      if (!response.ok) throw new Error(`读取房间成员失败：HTTP ${response.status}${await detail(response)}`);
      const rows = await response.json();
      const serverTime = Date.parse(response.headers && response.headers.get ? response.headers.get('date') : '') || Date.now();
      return { members: Array.isArray(rows) ? rows : [], serverTime };
    },

    /**
     * Create or refresh this device's member row (heartbeat + rename + seat).
     * `last_seen` is stamped by a database trigger, so all devices agree on it.
     */
    async heartbeat({ device, nickname, role, side = null, readyGame = 0 }) {
      const response = await fetchImpl(`${members}?on_conflict=room,device`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ room: code, device, nickname, role, side, ready_game: readyGame }]),
      });
      if (response.ok) return { ok: true };
      if (response.status === 409) return { ok: false, conflict: true, reason: '对手座位已经被占用' };
      return failure(response, '同步在线状态');
    },

    /**
     * Change one device's seat. Used by the host to promote/demote members and
     * to remove them (`role: 'kicked'`); `ready_game` is cleared so a seat
     * change always starts un-ready.
     */
    async setMemberRole({ device, role, side = null, readyGame = 0 }) {
      const response = await fetchImpl(
        `${members}?${roomFilter}&device=eq.${encodeURIComponent(device)}`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ role, side, ready_game: readyGame }),
        },
      );
      return response.ok ? { ok: true } : failure(response, '切换身份');
    },

    /** Remove a stale member row so a waiting spectator can take the seat. */
    async dropMember(device) {
      const response = await fetchImpl(
        `${members}?${roomFilter}&device=eq.${encodeURIComponent(device)}`,
        { method: 'DELETE', headers },
      );
      return response.ok ? { ok: true } : failure(response, '清理离线成员');
    },

    /** Best-effort cleanup when leaving a room. */
    async leaveRoom(device) {
      return this.dropMember(device);
    },
  };
}
