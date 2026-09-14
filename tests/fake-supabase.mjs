/**
 * In-memory stand-in for the Supabase/PostgREST endpoints that
 * `online/transports.js` talks to.
 *
 * It understands the small query subset the store uses: `eq.` / `gte.`
 * filters, `order=` and `limit=`, plus POST conflict handling (409) and
 * DELETE. That is enough to run the real page code end-to-end in Node.
 */

export function createFakeSupabase() {
  const db = { rooms: [], moves: [], events: [], members: [] };
  const calls = [];
  let moveId = 0;
  let eventId = 0;
  let clock = Date.parse('2026-09-14T08:00:00Z');

  const headers = () => ({
    get: (name) => (String(name).toLowerCase() === 'date' ? new Date(clock).toUTCString() : null),
  });
  const ok = (data, status = 200) => ({ ok: true, status, headers: headers(), json: async () => data, text: async () => '' });
  const fail = (status, text) => ({ ok: false, status, headers: headers(), json: async () => [], text: async () => text });
  const stamp = () => new Date(clock).toISOString();

  function select(rows, params, order) {
    let out = rows.slice();
    for (const [key, value] of params.entries()) {
      if (key === 'select' || key === 'order' || key === 'limit') continue;
      const eq = /^eq\.(.*)$/.exec(value);
      if (eq) out = out.filter((row) => String(row[key]) === eq[1]);
      const gte = /^gte\.(.*)$/.exec(value);
      if (gte) out = out.filter((row) => Number(row[key]) >= Number(gte[1]));
    }
    if (order) {
      const [column, direction] = order.split('.');
      out.sort((a, b) => (Number(a[column]) - Number(b[column])) * (direction === 'desc' ? -1 : 1));
    }
    const limit = params.get('limit');
    if (limit) out = out.slice(0, Number(limit));
    return out;
  }

  const fetchImpl = async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    const [path, search] = String(url).split('?');
    const params = new URLSearchParams(search || '');
    const table = path.slice(path.indexOf('/rest/v1/') + '/rest/v1/'.length);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ table, method, params, body, headers: options.headers || {} });

    if (table === 'rooms') {
      if (method === 'GET') return ok(select(db.rooms, params));
      if (method === 'POST') {
        const row = body[0];
        if (db.rooms.some((room) => room.code === row.code)) return fail(409, 'duplicate key value violates unique constraint "rooms_pkey"');
        db.rooms.push({ ...row });
        return ok([], 201);
      }
      if (method === 'PATCH') {
        for (const row of select(db.rooms, params)) Object.assign(row, body);
        return ok([], 204);
      }
      if (method === 'DELETE') {
        const doomed = new Set(select(db.rooms, params));
        db.rooms = db.rooms.filter((room) => !doomed.has(room));
        return ok([], 204);
      }
    }

    if (table === 'moves') {
      if (method === 'GET') return ok(select(db.moves, params, params.get('order')));
      if (method === 'POST') {
        const row = body[0];
        const clash = db.moves.some(
          (move) => move.room === row.room && Number(move.game) === Number(row.game) && Number(move.move_index) === Number(row.move_index),
        );
        if (clash) return fail(409, 'duplicate key value violates unique constraint "moves_room_game_index_unique"');
        moveId += 1;
        db.moves.push({ id: moveId, created_at: new Date().toISOString(), ...row });
        return ok([], 201);
      }
      if (method === 'DELETE') {
        const doomed = new Set(select(db.moves, params));
        db.moves = db.moves.filter((move) => !doomed.has(move));
        return ok([], 204);
      }
    }

    if (table === 'events') {
      if (method === 'GET') return ok(select(db.events, params, params.get('order')));
      if (method === 'POST') {
        const row = body[0];
        eventId += 1;
        db.events.push({ id: eventId, created_at: new Date().toISOString(), ...row });
        return ok([], 201);
      }
      if (method === 'DELETE') {
        const doomed = new Set(select(db.events, params));
        db.events = db.events.filter((event) => !doomed.has(event));
        return ok([], 204);
      }
    }

    if (table === 'members') {
      if (method === 'GET') return ok(select(db.members, params, params.get('order')));
      if (method === 'POST') {
        const row = body[0];
        const existing = db.members.find((member) => member.room === row.room && member.device === row.device);
        if (existing) {
          Object.assign(existing, row, { last_seen: stamp() });
          return ok([], 201);
        }
        // Mirrors the partial unique index that keeps a single opponent seat.
        if (row.role === 'guest' && db.members.some((member) => member.room === row.room && member.role === 'guest')) {
          return fail(409, 'duplicate key value violates unique constraint "members_room_guest_unique"');
        }
        db.members.push({ joined_at: stamp(), last_seen: stamp(), ...row });
        return ok([], 201);
      }
      if (method === 'PATCH') {
        for (const row of select(db.members, params)) Object.assign(row, body, { last_seen: stamp() });
        return ok([], 204);
      }
      if (method === 'DELETE') {
        const doomed = new Set(select(db.members, params));
        db.members = db.members.filter((member) => !doomed.has(member));
        return ok([], 204);
      }
    }

    return fail(404, `unknown table ${table}`);
  };

  return {
    db,
    calls,
    fetchImpl,
    /** Move the fake server clock (presence is judged against it). */
    advance(ms) {
      clock += ms;
    },
    now: () => clock,
    room: (code) => db.rooms.find((row) => row.code === code) || null,
    movesOf: (code, game = 1) => db.moves.filter((row) => row.room === code && Number(row.game) === Number(game)),
    eventsOf: (code, game = 1) => db.events.filter((row) => row.room === code && Number(row.game) === Number(game)),
    membersOf: (code) => db.members.filter((row) => row.room === code),
    /** Pretend another device is sitting in the room (a guest or a spectator). */
    injectMember({ room, device, nickname, role, side = null, lastSeenAgoMs = 0 }) {
      db.members.push({
        room,
        device,
        nickname,
        role,
        side,
        joined_at: stamp(),
        last_seen: new Date(clock - lastSeenAgoMs).toISOString(),
      });
    },
    /** Pretend the other player played this move (no page involved). */
    injectMove({ room, game = 1, moveIndex, side, x, y }) {
      moveId += 1;
      db.moves.push({ id: moveId, room, game, move_index: moveIndex, side, x, y, created_at: new Date().toISOString() });
    },
    injectEvent({ room, game = 1, kind, side, target = null }) {
      eventId += 1;
      db.events.push({ id: eventId, room, game, kind, side, target, created_at: new Date().toISOString() });
    },
  };
}
