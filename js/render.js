'use strict';

/*
 * Spot Kick render — Three.js night stadium focused on the goalmouth.
 * Procedural geometry and materials only; deterministic visual seed; quality
 * tiers control pixel ratio/shadows/particles, never rules. Raycasts run only
 * against the explicit interaction layer (goal zones). Animations interpolate
 * from simulation events and skip() settles exact end states.
 */
(function (root, factory) {
  const api = factory(root.THREE);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickRender = api;
})(typeof self !== 'undefined' ? self : this, function (THREE) {

  // Framing constants (exposed, not magic numbers buried in code)
  const FRAME = {
    GOAL_W: 7.32, GOAL_H: 2.44,        // regulation proportions, stylized scale
    BALL_R: 0.22,
    SPOT: { x: 0, y: 0.22, z: 11 },    // penalty spot
    GOAL_Z: 0,
    CAM_SHOOT: { x: 0, y: 2.6, z: 17.5, lx: 0, ly: 1.4, lz: 0 },
    CAM_KEEP: { x: 0, y: 2.4, z: -9.5, lx: 0, ly: 1.3, lz: 11 },
    CAM_TRANS_MS: 900
  };

  const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_FX = 2;

  let renderer = null, scene = null, camera = null, canvas = null;
  let raycaster = null, pointerV = null;
  let zones = [];              // interaction meshes: {mesh, dir, height}
  let zoneHighlight = null;
  let keeper = null, ball = null, net = null, goalGroup = null;
  let crowd = null, flood = [], pitch = null;
  let quality = 'high', reducedMotion = false;
  let theme = null;
  let anim = null;             // active kick animation
  let camAnim = null;
  let pickCallback = null, hoverCallback = null;
  let shakeAmp = 0;
  let built = false, webglOk = true;

  function init(canvasEl, opts) {
    opts = opts || {};
    canvas = canvasEl;
    pickCallback = opts.onPick || null;
    hoverCallback = opts.onHover || null;
    raycaster = new THREE.Raycaster();
    pointerV = new THREE.Vector2();
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'default' });
    } catch (e) {
      webglOk = false;
      return false;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 220);
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);
    bindPointer();
    return true;
  }

  function isWebglOk() { return webglOk; }

  function onContextLost(e) { e.preventDefault(); webglOk = false; }
  function onContextRestored() { webglOk = true; if (theme) buildScene(theme); }

  // ---------- scene construction (deterministic given theme) ----------
  function dispose(obj) {
    obj.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    });
  }

  function buildScene(themeDef) {
    theme = themeDef;
    if (scene) { dispose(scene); scene.clear(); }
    zones = []; flood = [];
    scene.background = new THREE.Color(theme.sky);
    scene.fog = new THREE.Fog(theme.sky, 40, 140);

    // lighting: one dominant key + soft fill + contact grounding
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(6, 14, 10);
    key.castShadow = quality === 'high';
    if (key.shadow) { key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -15; key.shadow.camera.right = 15; }
    scene.add(key);
    scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x0c1410, 0.5));
    const rim = new THREE.DirectionalLight(theme.accent, 0.6);
    rim.position.set(-8, 6, -6);
    scene.add(rim);

    // pitch
    const pitchMat = new THREE.MeshStandardMaterial({ color: theme.pitch, roughness: 0.95, metalness: 0 });
    pitch = new THREE.Mesh(new THREE.PlaneGeometry(80, 120), pitchMat);
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.z = 20;
    pitch.receiveShadow = quality !== 'low';
    pitch.layers.set(LAYER_ENV);
    scene.add(pitch);

    // pitch markings
    const lineMat = new THREE.MeshBasicMaterial({ color: theme.line });
    const addLine = (w, h, x, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.01, z);
      m.layers.set(LAYER_ENV);
      scene.add(m);
    };
    addLine(0.08, 16.5, -9.15, 8.25); addLine(0.08, 16.5, 9.15, 8.25);
    addLine(18.3, 0.08, 0, 16.5);
    addLine(0.08, 5.5, -4.6, 2.75); addLine(0.08, 5.5, 4.6, 2.75); addLine(9.2, 0.08, 0, 5.5);
    const spot = new THREE.Mesh(new THREE.CircleGeometry(0.12, 16), lineMat);
    spot.rotation.x = -Math.PI / 2; spot.position.set(0, 0.012, 11); scene.add(spot);

    buildGoal(themeDef);
    buildKeeper(themeDef);
    buildBall(themeDef);
    buildStands(themeDef);
    buildZoneHighlight(themeDef);

    built = true;
  }

  function buildGoal(t) {
    goalGroup = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0xf2f5fa, roughness: 0.4, metalness: 0.3 });
    const postR = 0.06;
    const mk = (geo, x, y, z) => {
      const m = new THREE.Mesh(geo, postMat);
      m.position.set(x, y, z); m.castShadow = quality === 'high'; m.layers.set(LAYER_GAME);
      goalGroup.add(m); return m;
    };
    const postGeo = new THREE.CylinderGeometry(postR, postR, FRAME.GOAL_H, 10);
    mk(postGeo, -FRAME.GOAL_W / 2, FRAME.GOAL_H / 2, FRAME.GOAL_Z);
    mk(postGeo, FRAME.GOAL_W / 2, FRAME.GOAL_H / 2, FRAME.GOAL_Z);
    const barGeo = new THREE.CylinderGeometry(postR, postR, FRAME.GOAL_W + postR * 2, 10);
    const bar = mk(barGeo, 0, FRAME.GOAL_H, FRAME.GOAL_Z);
    bar.rotation.z = Math.PI / 2;

    // net: thin line segments, never raycastable
    const netMat = new THREE.LineBasicMaterial({ color: 0xbcc8dd, transparent: true, opacity: 0.35 });
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const x = -FRAME.GOAL_W / 2 + (FRAME.GOAL_W * i / 12);
      pts.push(x, 0, -1.1, x, FRAME.GOAL_H, -1.1);
    }
    for (let j = 0; j <= 5; j++) {
      const y = FRAME.GOAL_H * j / 5;
      pts.push(-FRAME.GOAL_W / 2, y, -1.1, FRAME.GOAL_W / 2, y, -1.1);
    }
    const netGeo = new THREE.BufferGeometry();
    netGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    net = new THREE.LineSegments(netGeo, netMat);
    net.layers.set(LAYER_ENV);
    goalGroup.add(net);

    // interaction zones: 3 columns x 2 heights, explicit picking layer
    const cols = ['left', 'center', 'right'], rows = ['high', 'low'];
    const zoneGeo = new THREE.PlaneGeometry(FRAME.GOAL_W / 3, FRAME.GOAL_H / 2);
    cols.forEach((c, ci) => {
      rows.forEach((h, ri) => {
        const zm = new THREE.Mesh(zoneGeo, new THREE.MeshBasicMaterial({ visible: false }));
        zm.position.set(-FRAME.GOAL_W / 3 + ci * FRAME.GOAL_W / 3,
          FRAME.GOAL_H * 0.75 - ri * FRAME.GOAL_H / 2, FRAME.GOAL_Z - 0.05);
        zm.layers.set(LAYER_FX);
        zm.userData.zone = { dir: c, height: h };
        goalGroup.add(zm);
        zones.push(zm);
      });
    });
    scene.add(goalGroup);
  }

  function buildKeeper(t) {
    keeper = new THREE.Group();
    const kit = new THREE.MeshStandardMaterial({ color: t.accent, roughness: 0.6 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9b38c, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.75, 4, 10), kit);
    body.position.y = 0.95; body.castShadow = quality === 'high';
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), skin);
    head.position.y = 1.62;
    const armGeo = new THREE.CapsuleGeometry(0.06, 0.55, 3, 8);
    const armL = new THREE.Mesh(armGeo, kit); armL.position.set(-0.34, 1.15, 0); armL.rotation.z = 0.5;
    const armR = new THREE.Mesh(armGeo, kit); armR.position.set(0.34, 1.15, 0); armR.rotation.z = -0.5;
    const legGeo = new THREE.CapsuleGeometry(0.08, 0.6, 3, 8);
    const legL = new THREE.Mesh(legGeo, kit); legL.position.set(-0.13, 0.35, 0);
    const legR = new THREE.Mesh(legGeo, kit); legR.position.set(0.13, 0.35, 0);
    keeper.add(body, head, armL, armR, legL, legR);
    keeper.position.set(0, 0, FRAME.GOAL_Z + 0.4);
    keeper.userData.home = keeper.position.clone();
    keeper.traverse(o => o.layers.set(LAYER_GAME));
    scene.add(keeper);
  }

  function buildBall(t) {
    ball = new THREE.Mesh(
      new THREE.SphereGeometry(FRAME.BALL_R, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xf6f8fc, roughness: 0.35 })
    );
    // simple panel texture feel via a dark pentagon decal ring
    ball.castShadow = quality === 'high';
    ball.position.set(FRAME.SPOT.x, FRAME.SPOT.y, FRAME.SPOT.z);
    ball.userData.home = ball.position.clone();
    ball.layers.set(LAYER_GAME);
    scene.add(ball);
  }

  function buildStands(t) {
    // bowl silhouette + instanced crowd + floodlight towers
    const standMat = new THREE.MeshStandardMaterial({ color: 0x0d1526, roughness: 1 });
    for (const side of [-1, 1]) {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(46, 9, 6), standMat);
      stand.position.set(0, 3.2, -8 + side * -26);
      stand.layers.set(LAYER_ENV);
      scene.add(stand);
    }
    const seatGeo = new THREE.BoxGeometry(0.32, 0.5, 0.3);
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x1c2c4c, roughness: 0.9 });
    const count = quality === 'low' ? 220 : 700;
    crowd = new THREE.InstancedMesh(seatGeo, seatMat, count);
    const m = new THREE.Matrix4();
    // deterministic decorative placement (seeded LCG, decoration stream)
    let s = 0x1234abcd;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < count; i++) {
      const row = (i / 70) | 0;
      const x = -21 + (i % 70) * 0.62 + rnd() * 0.1;
      const y = 1.1 + row * 0.75 + rnd() * 0.12;
      const z = -12.5 - row * 0.9;
      m.makeTranslation(x, y, z);
      crowd.setMatrixAt(i, m);
    }
    crowd.layers.set(LAYER_ENV);
    scene.add(crowd);

    // floodlights: emissive quads + point glow
    const flMat = new THREE.MeshBasicMaterial({ color: 0xfff6da });
    for (const x of [-14, 14]) {
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 13, 8), standMat);
      tower.position.set(x, 6.5, -8);
      tower.layers.set(LAYER_ENV);
      scene.add(tower);
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), flMat);
      panel.position.set(x, 13.2, -8);
      panel.lookAt(0, 0, 10);
      panel.layers.set(LAYER_ENV);
      scene.add(panel);
      flood.push(panel);
    }
  }

  function buildZoneHighlight(t) {
    zoneHighlight = new THREE.Mesh(
      new THREE.PlaneGeometry(FRAME.GOAL_W / 3 - 0.12, FRAME.GOAL_H / 2 - 0.1),
      new THREE.MeshBasicMaterial({ color: t.accent, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    );
    zoneHighlight.visible = false;
    zoneHighlight.layers.set(LAYER_FX);
    scene.add(zoneHighlight);
  }

  // ---------- pointer interaction (explicit layers only) ----------
  function bindPointer() {
    const toNDC = (e) => {
      const r = canvas.getBoundingClientRect();
      pointerV.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    canvas.addEventListener('pointermove', (e) => {
      if (!built) return;
      toNDC(e);
      const hit = pickZone();
      showZoneHighlight(hit ? hit.userData.zone : null);
      if (hoverCallback) hoverCallback(hit ? hit.userData.zone : null);
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (!built) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      toNDC(e);
      const hit = pickZone();
      if (hit && pickCallback) pickCallback(hit.userData.zone);
    });
    canvas.addEventListener('pointercancel', () => showZoneHighlight(null));
    canvas.addEventListener('lostpointercapture', () => showZoneHighlight(null));
  }

  function pickZone() {
    raycaster.setFromCamera(pointerV, camera);
    raycaster.layers.set(LAYER_FX);
    const hits = raycaster.intersectObjects(zones, false);
    return hits.length ? hits[0].object : null;
  }

  function zoneCenter(zone) {
    const ci = ['left', 'center', 'right'].indexOf(zone.dir);
    const x = -FRAME.GOAL_W / 3 + ci * FRAME.GOAL_W / 3;
    const y = zone.height === 'high' ? FRAME.GOAL_H * 0.75 : FRAME.GOAL_H * 0.25;
    return new THREE.Vector3(x, y, FRAME.GOAL_Z);
  }

  function showZoneHighlight(zone) {
    if (!zoneHighlight) return;
    if (!zone) { zoneHighlight.visible = false; return; }
    zoneHighlight.position.copy(zoneCenter(zone));
    zoneHighlight.position.z = FRAME.GOAL_Z - 0.04;
    zoneHighlight.visible = true;
  }

  // ---------- camera ----------
  function setView(view, instant) {
    const target = view === 'keep' ? FRAME.CAM_KEEP : FRAME.CAM_SHOOT;
    const to = {
      pos: new THREE.Vector3(target.x, target.y, target.z),
      look: new THREE.Vector3(target.lx, target.ly, target.lz)
    };
    if (instant || reducedMotion || !camera) {
      camera.position.copy(to.pos);
      camera.lookAt(to.look);
      camera.userData.look = to.look.clone();
      camAnim = null;
      return;
    }
    camAnim = {
      t0: performance.now(), dur: FRAME.CAM_TRANS_MS,
      fromPos: camera.position.clone(),
      fromLook: (camera.userData.look || to.look).clone(),
      toPos: to.pos, toLook: to.look
    };
  }

  function updateCamera(now) {
    if (camAnim) {
      const a = Math.min(1, (now - camAnim.t0) / camAnim.dur);
      const e = 1 - Math.pow(1 - a, 3); // easeOutCubic, authored duration
      camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
      camera.userData.look = camAnim.fromLook.clone().lerp(camAnim.toLook, e);
      camera.lookAt(camera.userData.look);
      if (a >= 1) camAnim = null;
    }
    if (shakeAmp > 0.001 && !reducedMotion) {
      camera.position.x += (Math.random() - 0.5) * shakeAmp;
      camera.position.y += (Math.random() - 0.5) * shakeAmp * 0.6;
      shakeAmp *= 0.88;
    } else shakeAmp = 0;
  }

  // ---------- kick resolution animation ----------
  // Drives purely from a resolved event; skip() lands the exact end state.
  function playKick(ev, opts) {
    opts = opts || {};
    const dur = reducedMotion ? 350 : 900;
    const target = ev.outcome === 'offtarget'
      ? new THREE.Vector3((ev.finalCol === 'left' ? -1 : ev.finalCol === 'right' ? 1 : 0.4) * (FRAME.GOAL_W / 2 + 1.4),
          ev.shot.height === 'high' ? FRAME.GOAL_H + 0.9 : 0.5, FRAME.GOAL_Z - 2.2)
      : zoneCenter({ dir: ev.finalCol, height: ev.shot.height });
    const diveX = ['left', 'center', 'right'].indexOf(ev.dive.dir) - 1;
    const diveTarget = new THREE.Vector3(diveX * 2.6, ev.dive.height === 'high' ? 1.5 : 0.55, FRAME.GOAL_Z + 0.4);
    anim = {
      t0: performance.now(), dur: dur,
      ballFrom: ball.position.clone(), ballTo: target,
      curve: ev.shot.curve,
      keeperFrom: keeper.position.clone(), keeperTo: diveTarget,
      keeperRot: diveX * (ev.dive.height === 'high' ? 1.1 : 0.7),
      outcome: ev.outcome,
      onDone: opts.onDone || null
    };
    if (!reducedMotion) shakeAmp = ev.outcome === 'goal' ? 0.06 : 0.03;
    if (reducedMotion) updateAnim(performance.now() + dur); // settle instantly
    // Logic must never depend on rAF: if the tab hides mid-flight, force the
    // exact end state shortly after the authored duration elapses.
    const my = anim;
    setTimeout(() => { if (anim === my) skip(); }, dur + 300);
  }

  function updateAnim(now) {
    if (!anim) return;
    const a = Math.min(1, (now - anim.t0) / anim.dur);
    const e = a < 0.5 ? 2 * a * a : 1 - Math.pow(-2 * a + 2, 2) / 2;
    // ball flight with a light arc and lateral curve bend
    ball.position.lerpVectors(anim.ballFrom, anim.ballTo, e);
    ball.position.y += Math.sin(Math.PI * e) * 0.5;
    const bend = anim.curve === 'left' ? -1 : anim.curve === 'right' ? 1 : 0;
    ball.position.x += Math.sin(Math.PI * e) * bend * 0.9;
    ball.rotation.x -= 0.25;
    keeper.position.lerpVectors(anim.keeperFrom, anim.keeperTo, e);
    keeper.rotation.z = anim.keeperRot * e;
    if (a >= 1) {
      const done = anim.onDone;
      anim = null;
      if (done) done();
    }
  }

  function skip() {
    if (anim) { // settle exact end state
      ball.position.copy(anim.ballTo);
      keeper.position.copy(anim.keeperTo);
      keeper.rotation.z = anim.keeperRot;
      const done = anim.onDone;
      anim = null;
      if (done) done();
    }
    if (camAnim) {
      camera.position.copy(camAnim.toPos);
      camera.userData.look = camAnim.toLook.clone();
      camera.lookAt(camAnim.toLook);
      camAnim = null;
    }
    shakeAmp = 0;
  }

  function resetPositions() {
    if (!built) return;
    anim = null;
    ball.position.copy(ball.userData.home);
    keeper.position.copy(keeper.userData.home);
    keeper.rotation.set(0, 0, 0);
    showZoneHighlight(null);
  }

  function setInteractive(on) {
    zones.forEach(z => { z.visible = on; }); // visible=false material; flag via userData
    zones.forEach(z => { z.userData.enabled = on; });
  }

  // ---------- main loop hooks ----------
  function resize(w, h, dpr) {
    if (!renderer) return;
    const cap = quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1;
    renderer.setPixelRatio(Math.min(dpr || 1, cap));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function renderFrame(now) {
    if (!renderer || !built || !webglOk) return;
    updateAnim(now);
    updateCamera(now);
    renderer.render(scene, camera);
  }

  function setQuality(q) {
    if (q === quality) return;
    quality = q;
    if (renderer) renderer.shadowMap.enabled = q === 'high';
    if (theme) buildScene(theme); // rebuild shadow/instancing detail per tier
  }
  function getQuality() { return quality; }

  function setReducedMotion(v) { reducedMotion = !!v; if (reducedMotion) shakeAmp = 0; }
  function setTheme(themeDef) { buildScene(themeDef); setView('shoot', true); }

  // deterministic per-tier diagnostics for validation captures
  function stats() {
    if (!renderer) return null;
    const i = renderer.info;
    return { drawCalls: i.render.calls, triangles: i.render.triangles, quality: quality };
  }

  return {
    FRAME: FRAME,
    init: init, isWebglOk: isWebglOk,
    setTheme: setTheme, setQuality: setQuality, getQuality: getQuality,
    setReducedMotion: setReducedMotion,
    setView: setView, playKick: playKick, skip: skip, resetPositions: resetPositions,
    showZoneHighlight: showZoneHighlight, setInteractive: setInteractive,
    resize: resize, renderFrame: renderFrame, stats: stats
  };
});
