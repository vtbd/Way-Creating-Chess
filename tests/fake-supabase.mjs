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

  function select(rows, params, order, { project = true } = {}) {
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
    // PostgREST projects only the requested columns; honour `select` so the
    // trimmed polling queries are tested the same way they behave in Supabase.
    const columns = params.get('select');
    if (project && columns && columns !== '*') {
      const wanted = columns.split(',').map((name) => name.trim()).filter(Boolean);
      out = out.map((row) => {
        const projected = {};
        for (const column of wanted) if (row[column] !== undefined) projected[column] = row[column];
        return projected;
      });
    }
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
        for (const row of select(db.rooms, params, null, { project: false })) Object.assign(row, body);
        return ok([], 204);
      }
      if (method === 'DELETE') {
        const doomed = new Set(select(db.rooms, params, null, { project: false }));
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
        db.moves.push({ id: moveId, created_at: stamp(), ...row });
        return ok([], 201);
      }
      if (method === 'DELETE') {
        const doomed = new Set(select(db.moves, params, null, { project: false }));
        db.moves = db.moves.filter((move) => !doomed.has(move));
        return ok([], 204);
      }
    }

    if (table === 'events') {
      if (method === 'GET') return ok(select(db.events, params, params.get('order')));
      if (method === 'POST') {
        const row = body[0];
        eventId += 1;
        db.events.push({ id: eventId, created_at: stamp(), ...row });
        return ok([], 201);
      }
      if (method === 'DELETE') {
        const doomed = new Set(select(db.events, params, null, { project: false }));
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
          const readyChanged = Number(existing.ready_game || 0) !== Number(row.ready_game || 0);
          Object.assign(existing, row, { last_seen: stamp() });
          // Mirrors the `members_touch` trigger: ready_at moves only when the
          // ready flag itself changes.
          if (readyChanged) existing.ready_at = stamp();
          return ok([], 201);
        }
        // Mirrors the partial unique index that keeps a single opponent seat.
        if (row.role === 'guest' && db.members.some((member) => member.room === row.room && member.role === 'guest')) {
          return fail(409, 'duplicate key value violates unique constraint "members_room_guest_unique"');
        }
        db.members.push({ joined_at: stamp(), last_seen: stamp(), ready_at: stamp(), ...row });
        return ok([], 201);
      }
      if (method === 'PATCH') {
        for (const row of select(db.members, params, null, { project: false })) {
          const readyChanged = body.ready_game !== undefined && Number(row.ready_game || 0) !== Number(body.ready_game);
          Object.assign(row, body, { last_seen: stamp() });
          if (readyChanged) row.ready_at = stamp();
        }
        return ok([], 204);
      }
      if (method === 'DELETE') {
        const doomed = new Set(select(db.members, params, null, { project: false }));
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
    findMember: (room, role) => db.members.find((member) => member.room === room && member.role === role) || null,
    memberByDevice: (device) => db.members.find((member) => member.device === device) || null,
    /** Refresh a member's heartbeat without touching anything else. */
    touchMember(device) {
      const member = db.members.find((row) => row.device === device);
      if (member) member.last_seen = stamp();
      return member || null;
    },
    /** Ready (or un-ready) an existing member seat. */
    setReady(device, game) {
      const member = db.members.find((row) => row.device === device);
      if (!member) return null;
      member.ready_game = game;
      member.ready_at = stamp();
      member.last_seen = stamp();
      return member;
    },
    injectMember({ room, device, nickname, role, side = null, lastSeenAgoMs = 0, readyGame = 0 }) {
      db.members.push({
        room,
        device,
        nickname,
        role,
        side,
        joined_at: stamp(),
        last_seen: new Date(clock - lastSeenAgoMs).toISOString(),
        ready_game: readyGame,
        ready_at: readyGame ? stamp() : null,
      });
    },
    /** Pretend the other player played this move (no page involved). */
    injectMove({ room, game = 1, moveIndex, side, x, y }) {
      moveId += 1;
      // Stamped with the fake server clock so the game clocks stay coherent.
      db.moves.push({ id: moveId, room, game, move_index: moveIndex, side, x, y, created_at: stamp() });
    },
    injectEvent({ room, game = 1, kind, side, target = null }) {
      eventId += 1;
      db.events.push({ id: eventId, room, game, kind, side, target, created_at: stamp() });
    },
  };
}
