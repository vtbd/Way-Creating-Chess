/**
 * In-memory stand-in for the Supabase/PostgREST endpoints that
 * `online/transports.js` talks to.
 *
 * It understands the small query subset the store uses: `eq.` / `gte.`
 * filters, `order=` and `limit=`, plus POST conflict handling (409) and
 * DELETE. That is enough to run the real page code end-to-end in Node.
 */

export function createFakeSupabase() {
  const db = { rooms: [], moves: [], events: [] };
  const calls = [];
  let moveId = 0;
  let eventId = 0;

  const ok = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => '' });
  const fail = (status, text) => ({ ok: false, status, json: async () => [], text: async () => text });

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

    return fail(404, `unknown table ${table}`);
  };

  return {
    db,
    calls,
    fetchImpl,
    room: (code) => db.rooms.find((row) => row.code === code) || null,
    movesOf: (code, game = 1) => db.moves.filter((row) => row.room === code && Number(row.game) === Number(game)),
    eventsOf: (code, game = 1) => db.events.filter((row) => row.room === code && Number(row.game) === Number(game)),
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
