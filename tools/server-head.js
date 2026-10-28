// =============================================================================
// Spot Kick — the game's one authoritative server script (starhermit.txt
// `server=server.js`). The platform runs it in its sandboxed Jint host: a fresh
// engine per invocation, one classic script, no imports, no Date/Math.random,
// every bit of state in the documents it returns. The rules are the client's
// own js/rules.js, written into the RULES block below by
// tools/build-server.mjs (`npm run server`): edit tools/server-head.js, not
// server.js.
//
// It runs two kinds of session:
//
// 1. Online matches (room-bound sessions). An online match is a realtime room
//    of one team of two seats (slot 0 shoots first: side A, slot 1 is side B);
//    when it starts the platform creates a session bound to it and calls
//    createSession with `ctx.room` (the frozen roster) and `ctx.presence`.
//    This script owns the whole shootout, as the browser build's room host
//    did, but no client is trusted: every dive and shot goes through the
//    rules' validated applyCommand for the sender's own side
//    (`ctx.message.from`, never a side named in the payload), the committed
//    dive stays hidden from both clients until the kick resolves, an AI seat
//    (a roster AI, or a seat nobody took) is played by the rules' AI, a player
//    who left the room or stayed offline for 60 s concedes, and the end of the
//    match is the session's `result` (stored on the room by the platform).
//
//    Client → script (commands):
//      { type: 'sync' }                                the table and a snapshot, to the sender
//      { type: 'dive', tick, id, params: { dir, height, timing } }
//      { type: 'shoot', tick, id, params: { dir, height, curve } }
//      { type: 'forfeit' }                             the sender concedes (Leave match)
//    Script → clients (`broadcast`):
//      { type: 'table', seats: [{ side, name, ai, userId }] }          on sync
//      { type: 'snap', state, waitingFor, committed, kick }             after every change
//        (state without the pending dive; committed: a dive is in;
//         kick: the kick-resolved event this change produced, or null)
//      { type: 'rejected', reason }                    to the sender of a refused command
//      { type: 'over', winner, reason, breakdown, finalHash }           at the end
//
// 2. Score posting (any other session — the practice session the client opens
//    with sessions.practice()): a finished solo match's goals arrive as
//    { type: 'result', scores: { goals: n } }; they are range-checked against
//    BOARDS, returned in `scores` and the session ends — what the browser
//    build's score-script.js did.
'use strict';
