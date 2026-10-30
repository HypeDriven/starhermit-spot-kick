# Spot Kick — specification

Spot Kick is an alternating penalty-shootout duel under the floodlights: the
players take turns shooting and keeping goal, choosing a goal zone, a curve and
a dive timing across a five-kick set with sudden death on ties. It is a
StarHermit engine **script game** (TypeScript on the host API, engine 1.29.0,
`engine.minor=31`), played natively by the StarHermit client and in browsers by
the engine's web runtime from one package.

## Rules (js/rules.js, unchanged from the browser build)

- Six zones: left / center / right × low / high. Side A shoots first; each kick
  the keeper commits a dive (zone + timing early / on time / late) first, hidden
  from the shooter, then the shooter picks a zone and a curve (none / left /
  right). Curve shifts the ball one column at the last moment and carries a
  seeded 1-in-8 risk of missing the frame.
- An on-time dive into the ball's final zone saves; an early dive saves the
  zone or the whole column against a straight shot but is beaten by curve;
  late saves nothing. A correctly read zone that still concedes is a "perfect
  kick".
- Five kicks each (fewer in some stages), decided early when the gap cannot be
  closed; level after the set goes to sudden death kick for kick.
- Commands are validated (ids, ticks, turn, side, constraints); separate seeded
  streams for rules and AI; state hashes and replay verification; the AI
  (Casual / Club / Sharp) is deterministic.

## Modes (js/content.js)

- **Quick Match** — five kicks against the Club AI, or two players on this
  device (hot seat).
- **Daily Challenge** — one shared seed per UTC day (the platform's clock when
  it answered, else the device's), Club keeper; the first result of the day is
  recorded in the save.
- **Journey** — 40 authored stages in four blocks (straight shots, curve,
  pressure, mastery with short sets and restricted tools); goals win, win by 2
  or clean sheet; each unlocks the next.
- **Practice** — choose the keeper, undo allowed, unranked.
- **Challenge** — five constrained sets (curves only, low only, a 6-second
  decision clock — doubled by Timing assistance —, a clean sheet, no center).
- **Learn** — five interactive steps (aim, keep, bend it, dive timing, the set)
  over a three-kick match.
- **Online Match** (signed in) — a 1v1 match against another player, refereed
  by the StarHermit server (below).

## Screens and controls

Title (Play, Daily Challenge, Journey with its n/40 pill, Practice, Challenge,
Learn, Online Match, Help, Settings, Sign in or Invite a friend, the profile
line) → setup (rules line, options, Start Match / Back) → a 3-2-1 countdown →
the play HUD → results (breakdown table: goals, saves, perfect kicks, off
target, invalid actions, kicks taken; how it ended; replay verification;
leaderboard line; the Daily board; new achievements; Replay / Next / Menu).
Every screen draws over the live stadium; the pause overlay doubles as the
title's Settings.

Play HUD: status bar (mode, score, the Challenge's clock), objective, phase and
kick dots at the top; the shot / dive tray (the six-zone grid, the curve or
timing segment, the selection line, Kick! / Dive!) and the action buttons
(pause, skip animation, Undo in Practice, reset camera) at the bottom;
captions above the tray. Layouts by logical window size: wide (≥ 560 px: the
grid beside the segment), portrait (stacked), short landscape (≤ 500 px tall:
the tray a left column, the actions a right column, the goal between). The
camera's view offset frames the goal in the area the HUD leaves.

- **Pointer / touch:** a press on a goal zone in the 3D goal (or its grid
  button) selects it; hovering previews it. The goal's six zones are named
  targets ("Goal zone left high") for screen readers and play scripts.
- **Keyboard** (`control.*`, rebindable in the runtime's Options): arrows move
  the zone cursor, Enter / Space select the cursor's zone and confirm, Q / E
  cycle the curve, 1 / 2 / 3 dive early / on time / late, Esc pause, H help,
  U undo (Practice), C reset camera, S skip the animation. The old camelCase
  actions were renamed (`curve_left`, `curve_right`, `on_time`); players'
  old browser key overrides do not carry over.
- **Gamepad:** D-pad / left stick cursor, South select / confirm, shoulders
  curve, triggers early / late, West on time, Start pause, East undo, North
  skip, right stick press reset camera.

## Timing

The countdown (700 ms beats, then 350 ms), the 900 ms kick flight and camera
swing (350 ms / instant with reduced motion), the 900 ms pause after a kick
(250 ms), the decision clock, captions and toasts run on a clock advanced by
the runtime's 60 Hz fixed steps, so a match plays identically at any frame
rate and play scripts replay exactly. A hidden window pauses a solo match.

## Visuals (native/render.ts, native/quality.ts)

The browser build's three.js r160 night stadium on `starhermit:scene`:
clear-coated goal frame and stanchions, fine or coarse net, keeper with idle
sway, panel ball, striped pitch with markings and penalty arc, contact blobs,
stepped terraces with an instanced bobbing crowd (a WGSL vertex hook), dim LED
boards, four floodlight towers with HDR lamp banks, halos, additive light
shafts (WGSL) and drifting motes; five themes (the Monochrome one under the
runtime's high contrast). Lights ÷ π (r155+ units), `new RoomEnvironment(renderer)`
as each lit material's envMap. Post effects are the runtime's: ACES at 1.05,
bloom 0.55 / 0.45 / 0.92, the display-space grade and vignette, FXAA / SMAA /
MSAA. The runtime's quality tier picks the old presets' budgets (shading,
textures, segments, shadows, crowd and motes scaled by the level); the
runtime owns render scale, adaptive resolution and frame limits.

## Sound (native/audio.ts)

The authored one-shots in `sfx/` per event (effects bus; menu clicks on the
interface bus), the night pad and the low ambience rendered into loops on the
music bus (no ambience bus in the runtime); sudden death lifts the pad.
Captions show for meaningful sounds (Settings › Captions).

## Settings

The runtime's Options own volumes, mute, voice limit, graphics, language,
larger text, high contrast, reduced motion and vibration. The game's own
settings (engine `settings`, synced with the account): stadium theme,
left-handed controls, timing assistance, captions; plus How to play, Replay
tutorial and (paused) Leave match.

## Platform integration (native/platform.ts)

- **Save:** the progression (journey stages, achievements, daily results,
  streaks, stats, finished tutorial; js/progress.js) is the engine save, on the
  device and in the cloud slot; conflicts merge (union of stages and
  achievements, earliest unlock, larger stats). The browser build's cloud slot
  (`game:<slug>`, checksummed `session.encodeSave` text) is read as a foreign
  save, merged and replaced once. Its account settings keys carry over theme,
  left-handed, timing assistance, captions and the finished tutorial, then are
  removed. Guests' old browser localStorage progress does not migrate.
- **Leaderboard:** signed in, every finished match against the AI (Quick
  Match, Journey, Daily) posts the player's goals through a practice session
  of server.js, which range-checks them (0–100) for the `goals` board; the
  results show the rank. The Daily's results list the board's top ten.
- **Achievements** stay in the save (8, as before).
- **Online matches:** a room of one team with two seats (Create online match
  opens it for quick join; Quick join a match joins an open one or creates
  it). When both seats are taken the room starts and the platform binds a
  session of `server.js`, which owns the match: it applies each dive and shot
  for the sender's own side through the rules, hides the committed dive until
  the kick resolves, plays any AI seat, concedes for a player who leaves or
  stays offline 60 s (Leave match concedes too), and returns the result.
  Clients send `sync` on every (re)connection and resume a seat they still hold
  on launch. Online matches post no goals (as before).
- **Session end:** an expired session or new terms during an online match
  returns to the title with a notice (sign in again or play on this device).
- Invite a friend copies the platform's invite link.

## Files

`native/*.ts` (client), `js/rules.js`, `js/content.js`, `js/session.js`
(unchanged rules), `js/progress.js` (save model), `js/online.js` (rooms and the
game socket), `js/strings.js` + `js/sh-strings.js` (nine locales: en-US, en-GB,
es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT), `server.js` (generated by
`npm run server` from `tools/server-head.js`, `js/rules.js`,
`tools/server-body.js`), `assets/ui-style.json` (`npm run css` from
`tools/ui-style.css`), `index.html` + `starhermit-files.json` (`npm run
package`).

## Checks

- `npm run test:unit` — rules, content, session (the browser build's suites on
  node:test), progress, server.js (score path, referee, forfeits, a whole match
  against the rules), js/online.js, translations.
- `npm run test:native` — web index current, tsc, `starhermit check` with no
  warnings, and the play scripts from `tools/gen-plays.mjs` (simulated with the
  rules, so each expects its exact result): Journey 1–2 by mouse, Learn by
  finger on a DPR-3 phone, Practice by keys sideways with undo and pause,
  two players by keys, the Challenge clock running out, the menus, and today's
  Daily (generated at test time).
- `npm run test:online` — two runtimes on `--dev --local-platform` (alice
  hosts, bob quick-joins on a phone) play an online match to server.js's result.
- `npm run test:browser` — the packaged loader in GPU Chrome: Journey 1 by
  mouse (grid and goal clicks, a pause), Learn by finger on a DPR-3 phone, the
  Daily sideways.

## Known limitations

- The results line says "in sudden death · sudden death" for sudden-death
  endings (kept from the browser build).
- The curve keys cycle straight → left → right (E) and back (Q), as before.
- The old per-effect graphics overrides, render-scale slider and frame-rate
  readout are the runtime's Options now; music / effects / ambience / voice
  sliders map to the runtime's buses (no separate ambience or voice volume).
