'use strict';

/*
 * Spot Kick render — Three.js night stadium focused on the goalmouth.
 * Procedural geometry and materials only; deterministic visual seed. Graphics
 * settings (gfx.js) control pixel ratio, shadows, post-processing, image-based
 * lighting, surface detail, crowd and atmosphere — never rules. Raycasts run
 * only against the explicit interaction layer (goal zones). Animations
 * interpolate from simulation events and skip() settles exact end states.
 */
(function (root, factory) {
  const gfxModel = (typeof module !== 'undefined' && module.exports) ? require('./gfx') : root.SpotKickGfx;
  const api = factory(root.THREE, gfxModel, root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickRender = api;
})(typeof self !== 'undefined' ? self : this, function (THREE, GFX, root) {

  // Framing constants (exposed, not magic numbers buried in code)
  const FRAME = {
    GOAL_W: 7.32, GOAL_H: 2.44,        // regulation proportions, stylized scale
    BALL_R: 0.22,
    SPOT: { x: 0, y: 0.22, z: 11 },    // penalty spot
    GOAL_Z: 0,
    CAM_SHOOT: { x: 0, y: 2.6, z: 17.5, lx: 0, ly: 1.4, lz: 0 },
    CAM_KEEP: { x: 0, y: 2.4, z: -9.5, lx: 0, ly: 1.3, lz: 11 },
    CAM_TRANS_MS: 900,
    PLAY_CENTER: { x: 0, z: 5.5 },     // shadow frustum is fitted around the goal↔spot area
    PLAY_HALF: 8.5,
    CROWD_FULL: 1100, CROWD_SPARSE: 220
  };

  const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_FX = 2;

  let renderer = null, scene = null, camera = null, canvas = null;
  let raycaster = null, pointerV = null;
  let zones = [];              // interaction meshes: {mesh, dir, height}
  let zoneHighlight = null;
  let keeper = null, keeperRig = null, ball = null, goalGroup = null;
  let netPlain = null, netDetail = null;
  let crowd = null, pitch = null, keyLight = null, hemi = null;
  let atmosphere = null, motes = null, halos = [], ballBlob = null, keeperBlob = null;
  let mats = {};               // materials that depend on gfx state
  let tex = {};                // procedural textures (detail on/off)
  const U = { uTime: { value: 0 }, uBob: { value: 0 } }; // shared ambient-motion uniforms
  let reducedMotion = false;
  let theme = null;
  let anim = null;             // active kick animation
  let camAnim = null;
  let pickCallback = null, hoverCallback = null;
  let shakeAmp = 0;
  let built = false, webglOk = true;

  // graphics state
  let gpuName = '', detectedPreset = 'balanced', ctxMSAA = true;
  let savedGfx = {}, gfx = GFX.resolve({}, 'balanced');
  let composer = null, postKey = null, postFailed = false, gradePass = null;
  let envTex = null;
  let view = { w: 1, h: 1, dpr: 1 }, pixelRatio = 1, adaptiveScale = 1;
  let frameTimes = [], fps = 0, lastNow = 0, sizeDirty = true;

  function init(canvasEl, opts) {
    opts = opts || {};
    canvas = canvasEl;
    pickCallback = opts.onPick || null;
    hoverCallback = opts.onHover || null;
    raycaster = new THREE.Raycaster();
    pointerV = new THREE.Vector2();
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: opts.antialias !== false, powerPreference: 'default' });
    } catch (e) {
      webglOk = false;
      return false;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.enabled = false;
    const attrs = renderer.getContext().getContextAttributes();
    ctxMSAA = !!(attrs && attrs.antialias);
    gpuName = detectGpu(renderer.getContext());
    const mobile = !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches) ||
      /Mobi|Android|iPhone|iPad/i.test((root.navigator && root.navigator.userAgent) || '');
    detectedPreset = GFX.detectPreset(gpuName, { mobile: mobile });
    gfx = GFX.resolve(savedGfx, detectedPreset);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 220);
    // the camera must see every layer: environment, gameplay pieces (ball,
    // keeper, posts) and FX (zone highlight)
    camera.layers.enable(LAYER_GAME);
    camera.layers.enable(LAYER_FX);
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);
    if (root.addEventListener) root.addEventListener('spotkick-post-ready', () => { postKey = null; applyReflections(); });
    bindPointer();
    return true;
  }

  // Unmasked GPU name. Plain RENDERER first (already unmasked in Firefox, where
  // touching the debug extension logs a deprecation warning).
  function detectGpu(gl) {
    try {
      const plain = String(gl.getParameter(gl.RENDERER) || '');
      if (plain && !/^(webkit|mozilla|generic)/i.test(plain)) return plain;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || plain);
      return plain;
    } catch (_) { return ''; }
  }

  function isWebglOk() { return webglOk; }

  function onContextLost(e) { e.preventDefault(); webglOk = false; }
  function onContextRestored() {
    webglOk = true;
    envTex = null; postKey = null;
    if (theme) { buildScene(theme); applyGraphics(); }
  }

  // ---------- deterministic decoration stream ----------
  function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  function hex(c) { return '#' + new THREE.Color(c).getHexString(); }
  function shade(c, k) { const col = new THREE.Color(c); col.multiplyScalar(k); return '#' + col.getHexString(); }

  function canvasTex(w, h, draw, srgb) {
    if (typeof document === 'undefined') return null;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    if (srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  // ---------- static batching: one draw call per material for fixed props ----------
  let statics = new Map();
  function addStatic(mesh) {
    if (!statics.has(mesh.material)) statics.set(mesh.material, []);
    statics.get(mesh.material).push(mesh);
  }
  // Bake a list of same-material meshes (world transforms) into one mesh.
  function mergeMeshes(list, mat) {
    const geos = list.map(m => {
      m.updateMatrixWorld(true);
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);
      return g;
    });
    const merged = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      if (!geos.every(g => g.attributes[name])) continue;
      const size = geos[0].attributes[name].itemSize;
      const arr = new Float32Array(geos.reduce((n, g) => n + g.attributes[name].array.length, 0));
      let off = 0;
      for (const g of geos) { arr.set(g.attributes[name].array, off); off += g.attributes[name].array.length; }
      merged.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
    }
    geos.forEach(g => g.dispose());
    list.forEach(m => m.geometry.dispose());
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = list.some(m => m.castShadow);
    mesh.receiveShadow = list.some(m => m.receiveShadow);
    mesh.layers.mask = list[0].layers.mask;
    return mesh;
  }
  function flushStatics() {
    for (const [mat, list] of statics) scene.add(mergeMeshes(list, mat));
    statics = new Map();
  }

  // ---------- scene construction (deterministic given theme) ----------
  function dispose(obj) {
    obj.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.userData.geoSparse) { o.userData.geoSparse.dispose(); o.userData.geoFull.dispose(); }
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    });
    Object.values(tex).forEach(t => t && t.dispose());
    tex = {};
  }

  function buildScene(themeDef) {
    theme = themeDef;
    if (scene) { dispose(scene); scene.clear(); }
    zones = []; halos = []; mats = {};
    const horizon = new THREE.Color(theme.sky).lerp(new THREE.Color(theme.accent), 0.12).multiplyScalar(1.9);
    tex.sky = canvasTex(4, 256, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, shade(theme.sky, 0.55));
      grad.addColorStop(0.55, hex(theme.sky));
      grad.addColorStop(1, hex(horizon));
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
    });
    scene.background = tex.sky || new THREE.Color(theme.sky);
    scene.fog = new THREE.Fog(horizon, 40, 140);

    // lighting: one dominant key (floodlight bank) + hemisphere fill + accent rim
    keyLight = new THREE.DirectionalLight(0xfff4e2, 2.0);
    keyLight.target.position.set(FRAME.PLAY_CENTER.x, 0, FRAME.PLAY_CENTER.z);
    keyLight.position.set(7, 15, 13);
    const sc = keyLight.shadow.camera;
    sc.left = -FRAME.PLAY_HALF; sc.right = FRAME.PLAY_HALF; sc.top = FRAME.PLAY_HALF; sc.bottom = -FRAME.PLAY_HALF;
    sc.near = 4; sc.far = 40;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.02;
    keyLight.shadow.radius = 3;
    scene.add(keyLight, keyLight.target);
    hemi = new THREE.HemisphereLight(0x9ab8ff, 0x0c1410, 0.55);
    scene.add(hemi);
    const rim = new THREE.DirectionalLight(theme.accent, 0.7);
    rim.position.set(-8, 6, -6);
    scene.add(rim);
    const back = new THREE.DirectionalLight(0xdfe6ff, 0.5); // opposite floodlight bank
    back.position.set(-6, 12, -10);
    scene.add(back);

    buildPitch(themeDef);
    buildGoal(themeDef);
    buildKeeper(themeDef);
    buildBall(themeDef);
    buildStands(themeDef);
    buildZoneHighlight(themeDef);
    flushStatics();

    built = true;
    applyGraphics();
  }

  function buildPitch(t) {
    // mowing stripes (5 m bands along the pitch) with fine turf noise
    tex.pitch = canvasTex(256, 256, (g, w, h) => {
      const rnd = lcg(0x51a7);
      for (let b = 0; b < 2; b++) {
        g.fillStyle = shade(t.pitch, b ? 1.16 : 0.9);
        g.fillRect(0, b * h / 2, w, h / 2);
      }
      for (let i = 0; i < 9000; i++) {
        const v = rnd();
        g.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.028)' : 'rgba(0,0,0,0.04)';
        g.fillRect(rnd() * w, rnd() * h, 1, 1 + rnd() * 2);
      }
    });
    if (tex.pitch) { tex.pitch.wrapS = tex.pitch.wrapT = THREE.RepeatWrapping; tex.pitch.repeat.set(8, 12); }
    mats.pitch = new THREE.MeshStandardMaterial({ color: t.pitch, roughness: 0.95, metalness: 0, envMapIntensity: 0.15 });
    pitch = new THREE.Mesh(new THREE.PlaneGeometry(80, 120), mats.pitch);
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.z = 20;
    pitch.receiveShadow = true;
    pitch.layers.set(LAYER_ENV);
    scene.add(pitch);

    // pitch markings (lit, so they sit in the scene rather than glow)
    const lineMat = new THREE.MeshStandardMaterial({ color: t.line, roughness: 0.8, envMapIntensity: 0.1,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const addLine = (w, h, x, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.01, z);
      m.receiveShadow = true;
      m.layers.set(LAYER_ENV);
      addStatic(m);
    };
    addLine(0.1, 16.5, -9.15, 8.25); addLine(0.1, 16.5, 9.15, 8.25);
    addLine(18.3, 0.1, 0, 16.5);
    addLine(0.1, 5.5, -4.6, 2.75); addLine(0.1, 5.5, 4.6, 2.75); addLine(9.2, 0.1, 0, 5.5);
    addLine(60, 0.1, 0, 0); // goal line
    const spot = new THREE.Mesh(new THREE.CircleGeometry(0.12, 20), lineMat);
    spot.rotation.x = -Math.PI / 2; spot.position.set(0, 0.012, 11); spot.receiveShadow = true;
    addStatic(spot);
    // penalty arc
    const arc = new THREE.Mesh(new THREE.RingGeometry(9.1, 9.2, 48, 1, Math.PI * 1.29, Math.PI * 0.42), lineMat);
    arc.rotation.x = -Math.PI / 2; arc.position.set(0, 0.011, 11); arc.receiveShadow = true;
    addStatic(arc);

    // soft contact blobs: grounding that works with shadows disabled
    tex.blob = canvasTex(64, 64, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }, false);
    const blobMat = () => new THREE.MeshBasicMaterial({ map: tex.blob, color: tex.blob ? 0xffffff : 0x000000,
      transparent: true, depthWrite: false, opacity: 0.55 });
    const blobGeo = new THREE.PlaneGeometry(1, 1);
    ballBlob = new THREE.Mesh(blobGeo, blobMat());
    ballBlob.rotation.x = -Math.PI / 2;
    keeperBlob = new THREE.Mesh(blobGeo, blobMat());
    keeperBlob.rotation.x = -Math.PI / 2;
    keeperBlob.scale.set(1.1, 0.7, 1);
    scene.add(ballBlob, keeperBlob);
  }

  // Grid of line segments across a quad (corners a,b,c,d in order), n × m cells.
  function gridLines(pts, a, b, c, d, n, m, sag) {
    const P = (u, v) => {
      const top = a.clone().lerp(b, u), bot = d.clone().lerp(c, u);
      const p = top.lerp(bot, v);
      if (sag) p.z -= Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * sag;
      return p;
    };
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j < m; j++) { const p = P(i / n, j / m), q = P(i / n, (j + 1) / m); pts.push(p.x, p.y, p.z, q.x, q.y, q.z); }
    }
    for (let j = 0; j <= m; j++) {
      for (let i = 0; i < n; i++) { const p = P(i / n, j / m), q = P((i + 1) / n, j / m); pts.push(p.x, p.y, p.z, q.x, q.y, q.z); }
    }
  }

  function buildNet(cell, opacity) {
    const W = FRAME.GOAL_W / 2, H = FRAME.GOAL_H;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const topBack = -1.0, botBack = -2.0, backTop = H - 0.25;
    const pts = [];
    const nx = Math.round(FRAME.GOAL_W / cell), ny = Math.round(H / cell), nz = Math.max(3, Math.round(2 / cell));
    gridLines(pts, V(-W, backTop, topBack), V(W, backTop, topBack), V(W, 0, botBack), V(-W, 0, botBack), nx, ny, 0.12); // back
    gridLines(pts, V(-W, H, 0), V(W, H, 0), V(W, backTop, topBack), V(-W, backTop, topBack), nx, Math.max(2, Math.round(1 / cell)), 0); // roof
    for (const s of [-1, 1]) // sides
      gridLines(pts, V(s * W, H, 0), V(s * W, backTop, topBack), V(s * W, 0, botBack), V(s * W, 0, 0), nz, ny, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const net = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xd4dcea, transparent: true, opacity: opacity }));
    net.layers.set(LAYER_ENV);
    return net;
  }

  function buildGoal(t) {
    goalGroup = new THREE.Group();
    mats.post = new THREE.MeshPhysicalMaterial({ color: 0xf4f6fa, roughness: 0.32, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 0.6 });
    const postR = 0.06;
    const mk = (geo, x, y, z) => {
      const m = new THREE.Mesh(geo, mats.post);
      m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; m.layers.set(LAYER_GAME);
      addStatic(m); return m;
    };
    const postGeo = new THREE.CylinderGeometry(postR, postR, FRAME.GOAL_H, 16);
    mk(postGeo, -FRAME.GOAL_W / 2, FRAME.GOAL_H / 2, FRAME.GOAL_Z);
    mk(postGeo, FRAME.GOAL_W / 2, FRAME.GOAL_H / 2, FRAME.GOAL_Z);
    const barGeo = new THREE.CylinderGeometry(postR, postR, FRAME.GOAL_W + postR * 2, 16);
    const bar = mk(barGeo, 0, FRAME.GOAL_H, FRAME.GOAL_Z);
    bar.rotation.z = Math.PI / 2;
    // back stanchions holding the net
    const stMat = new THREE.MeshStandardMaterial({ color: 0x9aa4b4, roughness: 0.5, metalness: 0.6 });
    for (const s of [-1, 1]) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.4, 6), stMat);
      st.position.set(s * FRAME.GOAL_W / 2, 1.1, -1.5); st.rotation.x = 0.43;
      st.layers.set(LAYER_ENV);
      addStatic(st);
    }

    // net: line segments, never raycastable (coarse + fine variants for detail)
    netPlain = buildNet(0.61, 0.35);
    netDetail = buildNet(0.2, 0.3);
    goalGroup.add(netPlain, netDetail);

    // interaction zones: 3 columns x 2 heights, explicit picking layer
    const cols = ['left', 'center', 'right'], rows = ['high', 'low'];
    const zoneGeo = new THREE.PlaneGeometry(FRAME.GOAL_W / 3, FRAME.GOAL_H / 2);
    cols.forEach((c, ci) => {
      rows.forEach((h, ri) => {
        // double-sided so the keeper camera (behind the goal) can pick them too
        const zm = new THREE.Mesh(zoneGeo, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
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
    keeperRig = new THREE.Group(); // idle motion lives here, never on the logical root
    const kit = new THREE.MeshStandardMaterial({ color: t.accent, roughness: 0.55, envMapIntensity: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x151c2b, roughness: 0.7, envMapIntensity: 0.3 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9b38c, roughness: 0.7, envMapIntensity: 0.3 });
    const glove = new THREE.MeshPhysicalMaterial({ color: 0xf2f4f8, roughness: 0.45, clearcoat: 0.5, envMapIntensity: 0.5 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.5, 4, 14), kit);
    body.position.y = 1.08;
    const shorts = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.24, 0.26, 14), dark);
    shorts.position.y = 0.72;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 14), skin);
    head.position.y = 1.62;
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.165, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), dark);
    hair.position.y = 1.63;
    const armGeo = new THREE.CapsuleGeometry(0.06, 0.5, 3, 10);
    const mkArm = (s) => {
      const pivot = new THREE.Group(); pivot.position.set(s * 0.25, 1.36, 0);
      const arm = new THREE.Mesh(armGeo, kit); arm.position.y = -0.28;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10), glove); hand.position.y = -0.6;
      pivot.add(arm, hand); pivot.rotation.z = s * 2.4; // arms up and out, ready
      pivot.userData.base = pivot.rotation.z;
      return pivot;
    };
    const armL = mkArm(-1), armR = mkArm(1);
    const legGeo = new THREE.CapsuleGeometry(0.08, 0.5, 3, 10);
    const legL = new THREE.Mesh(legGeo, dark); legL.position.set(-0.12, 0.36, 0);
    const legR = new THREE.Mesh(legGeo, dark); legR.position.set(0.12, 0.36, 0);
    const sockGeo = new THREE.CylinderGeometry(0.085, 0.08, 0.26, 10);
    const sockL = new THREE.Mesh(sockGeo, kit); sockL.position.set(-0.12, 0.2, 0);
    const sockR = new THREE.Mesh(sockGeo, kit); sockR.position.set(0.12, 0.2, 0);
    // static body parts: one mesh per material; arms stay separate for idle motion
    keeperRig.add(mergeMeshes([body, sockL, sockR], kit), mergeMeshes([shorts, hair, legL, legR], dark), head, armL, armR);
    keeperRig.userData.arms = [armL, armR];
    keeper.add(keeperRig);
    keeper.position.set(0, 0, FRAME.GOAL_Z + 0.4);
    keeper.userData.home = keeper.position.clone();
    keeper.traverse(o => { o.layers.set(LAYER_GAME); if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(keeper);
  }

  function buildBall(t) {
    // classic panel ball on an equirectangular map
    tex.ball = canvasTex(512, 256, (g, w, h) => {
      g.fillStyle = '#f4f6fb'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#1b2233';
      const poly = (cx, cy, r, n, rot) => {
        g.beginPath();
        for (let k = 0; k < n; k++) {
          const a = rot + k * Math.PI * 2 / n;
          g.lineTo(cx + Math.cos(a) * r * 1.6, cy + Math.sin(a) * r);
        }
        g.closePath(); g.fill();
      };
      poly(w / 2, 6, 20, 5, 0); poly(w / 2, h - 6, 20, 5, Math.PI);
      for (let k = 0; k < 5; k++) {
        poly((k + 0.1) * w / 5, h * 0.3, 22, 5, -Math.PI / 2);
        poly((k + 0.6) * w / 5, h * 0.7, 22, 5, Math.PI / 2);
      }
      g.strokeStyle = 'rgba(40,50,70,0.35)'; g.lineWidth = 2;
      for (let k = 0; k < 10; k++) { g.beginPath(); g.moveTo(k * w / 10, 0); g.lineTo(k * w / 10 + 12, h); g.stroke(); }
    });
    mats.ball = new THREE.MeshPhysicalMaterial({ color: 0xdfe3ea, roughness: 0.5, clearcoat: 0.5, clearcoatRoughness: 0.25, envMapIntensity: 0.4 });
    ball = new THREE.Mesh(new THREE.SphereGeometry(FRAME.BALL_R, 32, 22), mats.ball);
    ball.castShadow = true;
    ball.position.set(FRAME.SPOT.x, FRAME.SPOT.y, FRAME.SPOT.z);
    ball.userData.home = ball.position.clone();
    ball.layers.set(LAYER_GAME);
    scene.add(ball);
  }

  // Stepped terrace + instanced crowd. dir = -1 (behind goal, faces +z) or +1.
  function terraceGeo(rows, rise, run) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    for (let r = 0; r < rows; r++) { shape.lineTo(r * run, (r + 1) * rise); shape.lineTo((r + 1) * run, (r + 1) * rise); }
    shape.lineTo(rows * run, 0);
    shape.lineTo(0, 0);
    const g = new THREE.ExtrudeGeometry(shape, { depth: 48, bevelEnabled: false });
    g.translate(0, 0, -24);
    g.rotateY(Math.PI / 2); // profile runs along -z, extrusion along x
    return g;
  }

  function buildStands(t) {
    const standMat = new THREE.MeshStandardMaterial({ color: 0x141d31, roughness: 0.95, envMapIntensity: 0.1 });
    const ROWS = 11, RISE = 0.75, RUN = 0.9;
    const stands = [{ z: -12.1, dir: -1 }, { z: 38, dir: 1 }];
    for (const s of stands) {
      const m = new THREE.Mesh(terraceGeo(ROWS, RISE, RUN), standMat);
      m.position.set(0, 0.2, s.z);
      if (s.dir > 0) m.rotation.y = Math.PI;
      m.layers.set(LAYER_ENV);
      addStatic(m);
      // roof canopy edge
      const roof = new THREE.Mesh(new THREE.BoxGeometry(48, 0.25, 5), standMat);
      roof.position.set(0, ROWS * RISE + 3.2, s.z + s.dir * (ROWS * RUN - 2));
      roof.layers.set(LAYER_ENV);
      addStatic(roof);
    }
    // perimeter LED boards behind the goal (dim, so the goalmouth stays clear)
    tex.boards = canvasTex(1024, 32, (g, w, h) => {
      g.fillStyle = '#0a1122'; g.fillRect(0, 0, w, h);
      g.font = 'bold 22px system-ui, sans-serif'; g.textBaseline = 'middle';
      for (let i = 0; i < 6; i++) {
        g.fillStyle = i % 2 ? hex(t.accent) : '#cfd8ea';
        g.fillText('SPOT KICK', i * 172 + 20, h / 2 + 1);
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(i * 172 + 150, 8, 4, 16);
      }
    });
    const boardMat = new THREE.MeshBasicMaterial({ map: tex.boards, color: 0x3c4352 });
    const boards = new THREE.Mesh(new THREE.PlaneGeometry(34, 0.8), boardMat);
    boards.position.set(0, 0.4, -7.2);
    boards.layers.set(LAYER_ENV);
    scene.add(boards);

    // crowd: low-poly supporters with per-instance kit colours and a gentle bob
    const personGeo = new THREE.CapsuleGeometry(0.15, 0.32, 2, 6);
    const personLow = new THREE.CylinderGeometry(0.13, 0.16, 0.62, 5, 1); // sparse tier: ~20 triangles
    const phase = new Float32Array(FRAME.CROWD_FULL);
    mats.crowd = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, envMapIntensity: 0.1 });
    mats.crowd.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = U.uTime; sh.uniforms.uBob = U.uBob;
      sh.vertexShader = 'attribute float aPhase;\nuniform float uTime;\nuniform float uBob;\n' +
        sh.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\n  transformed.y += uBob * 0.09 * max(0.0, sin(uTime * (2.2 + aPhase) + aPhase * 6.2831));');
    };
    crowd = new THREE.InstancedMesh(personGeo, mats.crowd, FRAME.CROWD_FULL);
    crowd.userData.geoFull = personGeo;
    crowd.userData.geoSparse = personLow;
    const m = new THREE.Matrix4();
    const rnd = lcg(0x1234abcd); // decoration stream
    const palette = [new THREE.Color(t.accent), new THREE.Color(0xe8edf5), new THREE.Color(0x26324a),
      new THREE.Color(t.accent).multiplyScalar(0.6), new THREE.Color(0x3b465e)];
    const col = new THREE.Color();
    // every seat of both stands, shuffled per stand so any prefix is an even scatter
    const perStand = FRAME.CROWD_FULL / 2, perRow = Math.ceil(perStand / ROWS);
    const seats = stands.map((st) => {
      const list = [];
      for (let k = 0; k < perStand; k++) list.push({ st: st, row: k % ROWS, slot: (k / ROWS) | 0 });
      for (let k = list.length - 1; k > 0; k--) { const j = (rnd() * (k + 1)) | 0; const tmp = list[k]; list[k] = list[j]; list[j] = tmp; }
      return list;
    });
    // the sparse prefix favours the stand behind the goal (the one the shooter sees)
    const goalFirst = Math.round(FRAME.CROWD_SPARSE * 0.72);
    const order = seats[0].slice(0, goalFirst).concat(seats[1].slice(0, FRAME.CROWD_SPARSE - goalFirst),
      seats[0].slice(goalFirst), seats[1].slice(FRAME.CROWD_SPARSE - goalFirst));
    order.forEach((seat, i) => {
      const x = -21.5 + (seat.slot / perRow) * 43 + (rnd() - 0.5) * 0.25;
      const y = 0.2 + (seat.row + 1) * RISE + 0.33 + rnd() * 0.06;
      const z = seat.st.z + seat.st.dir * (seat.row * RUN + RUN * 0.5);
      m.makeTranslation(x, y, z);
      crowd.setMatrixAt(i, m);
      col.copy(palette[(rnd() * palette.length) | 0]).multiplyScalar(0.75 + rnd() * 0.35);
      crowd.setColorAt(i, col);
      phase[i] = rnd();
    });
    const phaseAttr = new THREE.InstancedBufferAttribute(phase, 1);
    personGeo.setAttribute('aPhase', phaseAttr);
    personLow.setAttribute('aPhase', phaseAttr);
    crowd.frustumCulled = false;
    crowd.layers.set(LAYER_ENV);
    scene.add(crowd);

    // floodlight towers: lamp banks are HDR emitters (they bloom when bloom is on)
    tex.lamps = canvasTex(128, 64, (g, w, h) => {
      g.fillStyle = '#2a2f3a'; g.fillRect(0, 0, w, h);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) {
        const gr = g.createRadialGradient(10 + c * 21.6, 11 + r * 21, 1, 10 + c * 21.6, 11 + r * 21, 9);
        gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.6, '#fff3d6'); gr.addColorStop(1, '#6d6656');
        g.fillStyle = gr; g.beginPath(); g.arc(10 + c * 21.6, 11 + r * 21, 8.5, 0, Math.PI * 2); g.fill();
      }
    });
    const lampMat = new THREE.MeshBasicMaterial({ map: tex.lamps, color: new THREE.Color(0xfff6da).multiplyScalar(3.2), fog: false });
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x2a3144, roughness: 0.6, metalness: 0.5 });
    tex.halo = canvasTex(64, 64, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,240,210,0.45)'); gr.addColorStop(1, 'rgba(255,240,210,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    atmosphere = new THREE.Group();
    const lampTargets = [];
    for (const z of [-8, 28]) {
      for (const x of [-15, 15]) {
        const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.26, 14, 8), towerMat);
        tower.position.set(x, 7, z);
        tower.layers.set(LAYER_ENV);
        addStatic(tower);
        const lampPos = new THREE.Vector3(x, 14.2, z);
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.3), lampMat);
        panel.position.copy(lampPos);
        panel.lookAt(0, 0, 6);
        panel.layers.set(LAYER_ENV);
        addStatic(panel);
        const backing = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.5, 0.2), towerMat);
        backing.position.copy(lampPos); backing.quaternion.copy(panel.quaternion); backing.translateZ(-0.12);
        backing.layers.set(LAYER_ENV);
        addStatic(backing);
        lampTargets.push({ lamp: lampPos, target: new THREE.Vector3(x * 0.2, 0, z < 0 ? 4 : 8), quat: panel.quaternion });
      }
    }
    // atmosphere: halos, light shafts and drifting motes
    for (const L of lampTargets) {
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.halo, color: 0xfff1d0, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, fog: false, opacity: 0.75 }));
      halo.position.copy(L.lamp).addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(L.quat), 0.2);
      halo.scale.setScalar(7);
      halos.push(halo);
      atmosphere.add(halo);
      const dir = L.lamp.clone().sub(L.target);
      const len = dir.length();
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 5.5, len, 28, 1, true), beamMaterial());
      beam.position.copy(L.lamp).add(L.target).multiplyScalar(0.5);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      beam.renderOrder = 2;
      atmosphere.add(beam);
    }
    const N = 260, pos = new Float32Array(N * 3), base = new Float32Array(N * 3);
    const mr = lcg(0x77aa11);
    for (let i = 0; i < N; i++) {
      base[i * 3] = (mr() - 0.5) * 24; base[i * 3 + 1] = 0.4 + mr() * 9; base[i * 3 + 2] = -4 + mr() * 20;
    }
    pos.set(base);
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    motes = new THREE.Points(mg, new THREE.PointsMaterial({ color: 0xfff0cc, size: 0.035, map: tex.halo, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.7 }));
    motes.userData.base = base;
    motes.frustumCulled = false;
    atmosphere.add(motes);
    atmosphere.traverse(o => o.layers.set(LAYER_ENV));
    scene.add(atmosphere);
  }

  // Soft additive light shaft: brightest near the lamp, fading at silhouette edges.
  function beamMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xfff0d0) }, uOpacity: { value: 0.07 } },
      vertexShader: `
        varying float vY; varying vec3 vN; varying vec3 vV;
        void main() {
          vY = position.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uOpacity;
        varying float vY; varying vec3 vN; varying vec3 vV;
        void main() {
          float edge = pow(abs(dot(normalize(vN), normalize(vV))), 2.0);
          float along = clamp(vY * 0.06 + 0.55, 0.0, 1.0);
          gl_FragColor = vec4(uColor * uOpacity * edge * along, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
  }

  function buildZoneHighlight(t) {
    const w = FRAME.GOAL_W / 3 - 0.12, h = FRAME.GOAL_H / 2 - 0.1;
    const geo = new THREE.PlaneGeometry(w, h);
    zoneHighlight = new THREE.Mesh(geo,
      new THREE.MeshBasicMaterial({ color: t.accent, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
    // outline so selection never relies on a translucent fill alone
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: t.accent }));
    zoneHighlight.add(edge);
    zoneHighlight.visible = false;
    zoneHighlight.layers.set(LAYER_FX);
    edge.layers.set(LAYER_FX);
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
  let currentView = 'shoot';
  let safeInsets = { top: 0, bottom: 0, left: 0, right: 0 }; // CSS px covered by HUD

  function setSafeInsets(ins) {
    safeInsets = Object.assign({ top: 0, bottom: 0, left: 0, right: 0 }, ins || {});
    if (!camera) return;
    applyViewOffset();
    setView(currentView, true);
  }

  // Frame the scene inside the part of the canvas not covered by HUD chrome.
  function applyViewOffset() {
    if (!renderer || !camera) return;
    const W = view.w || 1, H = view.h || 1;
    const sw = Math.max(1, W - safeInsets.left - safeInsets.right);
    const sh = Math.max(1, H - safeInsets.top - safeInsets.bottom);
    if (sw < W * 0.4 || sh < H * 0.28) { camera.aspect = W / H; camera.clearViewOffset(); }
    else { camera.aspect = sw / sh; camera.setViewOffset(sw, sh, -safeInsets.left, -safeInsets.top, W, H); }
    camera.updateProjectionMatrix();
  }

  // Authored camera, pulled straight back along its own axis until the whole
  // goal (plus padding) fits the horizontal and vertical field of view.
  function fittedTarget(v) {
    const t = v === 'keep' ? FRAME.CAM_KEEP : FRAME.CAM_SHOOT;
    const pos = new THREE.Vector3(t.x, t.y, t.z), look = new THREE.Vector3(t.lx, t.ly, t.lz);
    const probe = new THREE.PerspectiveCamera(camera.fov, camera.aspect || 1, 0.1, 220);
    const pts = [];
    const pad = 0.9;
    for (const x of [-FRAME.GOAL_W / 2 - pad, FRAME.GOAL_W / 2 + pad])
      for (const y of [-0.2, FRAME.GOAL_H + pad]) pts.push(new THREE.Vector3(x, y, FRAME.GOAL_Z));
    // the ball on the spot is kept in frame too, except in very short viewports
    // where the goal (the actual target) needs all the height it can get
    const shortView = camera.view ? camera.view.fullHeight < 300 : false;
    if (v !== 'keep' && !shortView) pts.push(new THREE.Vector3(0, 0, FRAME.SPOT.z + 0.6));
    const dir = pos.clone().sub(look).normalize();
    const q = new THREE.Vector3();
    // start closer than authored and pull back until everything fits, so the
    // goal fills the usable area on every aspect ratio
    const d0 = pos.distanceTo(look);
    pos.copy(look).addScaledVector(dir, d0 * 0.6);
    for (let i = 0; i < 16; i++) {
      probe.position.copy(pos); probe.lookAt(look); probe.updateMatrixWorld(); probe.updateProjectionMatrix();
      let over = 0;
      for (const p of pts) { q.copy(p).project(probe); over = Math.max(over, Math.abs(q.x) / 0.95, Math.abs(q.y) / 0.92); }
      if (over <= 1) break;
      const d = pos.distanceTo(look);
      pos.copy(look).addScaledVector(dir, d * Math.min(1.6, over + 0.02));
    }
    return { pos: pos, look: look };
  }

  function setView(v, instant) {
    currentView = v === 'keep' ? 'keep' : 'shoot';
    if (!camera) return;
    const to = fittedTarget(currentView);
    if (scene && scene.fog) { // fog follows the fitted distance so a far camera never fogs the goal
      const d = to.pos.distanceTo(new THREE.Vector3(0, 0, FRAME.GOAL_Z));
      scene.fog.near = d + 22; scene.fog.far = d + 120;
    }
    if (instant || reducedMotion) {
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

  // ---------- ambient motion (cosmetic; frozen under reduced motion) ----------
  let ambientT = 0;
  function updateAmbient(dt) {
    const moving = !reducedMotion;
    if (moving) ambientT += dt / 1000;
    U.uTime.value = ambientT;
    U.uBob.value = moving && gfx.crowd === 'full' ? 1 : 0;
    // keeper idle: weight shift + ready arms, only while not diving
    if (keeperRig) {
      const idle = moving && !anim && keeper.rotation.z === 0;
      keeperRig.position.y = idle ? Math.abs(Math.sin(ambientT * 3.1)) * 0.035 : 0;
      keeperRig.position.x = idle ? Math.sin(ambientT * 1.3) * 0.06 : 0;
      keeperRig.userData.arms.forEach((a, i) => { a.rotation.z = a.userData.base + (idle ? Math.sin(ambientT * 2.4 + i) * 0.08 : 0); });
    }
    if (atmosphere && atmosphere.visible && motes) {
      const p = motes.geometry.attributes.position, b = motes.userData.base, arr = p.array;
      if (moving) {
        for (let i = 0; i < arr.length; i += 3) {
          const ph = i * 0.37;
          arr[i] = b[i] + Math.sin(ambientT * 0.23 + ph) * 0.9;
          arr[i + 1] = b[i + 1] + Math.sin(ambientT * 0.31 + ph * 1.7) * 0.5;
          arr[i + 2] = b[i + 2] + Math.cos(ambientT * 0.19 + ph) * 0.9;
        }
        p.needsUpdate = true;
      }
      halos.forEach((h, i) => { h.material.opacity = 0.7 + (moving ? Math.sin(ambientT * 7 + i * 2.1) * 0.03 : 0); });
    }
    // contact blobs follow the ball / keeper
    if (ballBlob && ball) {
      const hgt = Math.max(0, ball.position.y - FRAME.BALL_R);
      ballBlob.position.set(ball.position.x, 0.015, ball.position.z);
      const s = 0.62 + hgt * 0.25; ballBlob.scale.set(s, s, 1);
      ballBlob.material.opacity = (gfx.shadows === 'off' ? 0.6 : 0.35) / (1 + hgt);
    }
    if (keeperBlob && keeper) {
      keeperBlob.position.set(keeper.position.x, 0.014, keeper.position.z);
      keeperBlob.visible = keeper.position.y < 0.8;
    }
  }

  // ---------- graphics settings ----------
  /** Apply saved graphics settings (object from the Graphics panel; {} = auto). Live, no reload. */
  function setGraphics(saved) {
    savedGfx = Object.assign({}, saved || {});
    gfx = GFX.resolve(savedGfx, detectedPreset);
    adaptiveScale = 1;
    frameTimes = [];
    sizeDirty = true;
    postKey = null; // rebuild the post chain on the next frame
    postFailed = false;
    applyGraphics();
    fpsVisible(gfx.showFps);
    if (canvas) {
      canvas.dataset.gfxPreset = gfx.preset;
      canvas.dataset.gfxAuto = gfx.auto ? 'true' : 'false';
    }
    return gfx;
  }

  function applyGraphics() {
    if (!renderer) return;
    const size = GFX.SHADOW_MAP[gfx.shadows] || 0;
    renderer.shadowMap.enabled = size > 0;
    if (keyLight) {
      keyLight.castShadow = size > 0;
      if (size > 0 && keyLight.shadow.mapSize.x !== size) {
        keyLight.shadow.mapSize.set(size, size);
        if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
      }
    }
    if (!built) return;
    // surface detail
    const detailed = gfx.detail === 'detailed';
    if (mats.pitch) {
      mats.pitch.map = detailed ? tex.pitch : null;
      mats.pitch.color.set(detailed && tex.pitch ? 0xffffff : theme.pitch);
    }
    if (mats.ball) mats.ball.map = detailed ? tex.ball : null;
    if (netPlain) netPlain.visible = !detailed;
    if (netDetail) netDetail.visible = detailed;
    if (crowd) {
      const full = gfx.crowd === 'full';
      crowd.count = full ? FRAME.CROWD_FULL : FRAME.CROWD_SPARSE;
      crowd.geometry = full ? crowd.userData.geoFull : crowd.userData.geoSparse;
    }
    // atmosphere stays off in the high-contrast theme so nothing hazes the goal
    if (atmosphere) atmosphere.visible = gfx.atmosphere === 'on' && theme.id !== 'mono';
    applyReflections();
    // materials recompile for shadow / map changes
    scene.traverse(o => {
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; });
    });
  }

  function applyReflections() {
    if (!scene || !built) return;
    const P = root.SpotKickPost;
    if (gfx.reflections === 'on' && !envTex && P && P.RoomEnvironment && renderer) {
      try {
        const pm = new THREE.PMREMGenerator(renderer);
        const room = new P.RoomEnvironment(renderer);
        envTex = pm.fromScene(room, 0.04).texture;
        room.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        pm.dispose();
      } catch (_) { envTex = null; }
    }
    const on = gfx.reflections === 'on' && !!envTex;
    scene.environment = on ? envTex : null;
    if (hemi) hemi.intensity = on ? 0.35 : 0.55;
  }

  function fpsVisible(on) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('fps-meter');
    if (el) { el.classList.toggle('hidden', !on); if (!on) el.textContent = ''; }
  }

  /** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  function graphicsInfo() {
    const px = [Math.round(view.w * pixelRatio), Math.round(view.h * pixelRatio)];
    return {
      gpu: gpuName || 'unknown GPU', detected: detectedPreset, resolved: gfx,
      summary: GFX.describe(gfx, px), pixels: px,
      fps: Math.round(fps || 0), adaptiveScale: Math.round(adaptiveScale * 100) / 100,
      postFailed: !!postFailed, postAvailable: !!root.SpotKickPost
    };
  }

  function needsPost() {
    return gfx.post || (gfx.antialias === 'msaa' && !ctxMSAA);
  }

  function currentPostKey() {
    if (!needsPost() || postFailed) return 'none';
    return [gfx.bloom, gfx.grade, gfx.antialias, view.w, view.h, pixelRatio, !!root.SpotKickPost].join('|');
  }

  // Colour grade + vignette (display-space in, display-space out; runs after OutputPass tone mapping).
  const GradeShader = {
    uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
      varying vec2 vUv;
      void main() {
        vec4 src = texture2D(tDiffuse, vUv);
        vec3 c = clamp(src.rgb, 0.0, 1.0);
        // gentle S-curve contrast, a touch more saturation, cool shadows / warm floodlit highlights
        vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
        float l = dot(s, vec3(0.299, 0.587, 0.114));
        s = mix(vec3(l), s, 1.1);
        s *= mix(vec3(0.95, 0.98, 1.06), vec3(1.04, 1.01, 0.96), smoothstep(0.25, 0.85, l));
        s = s * 0.975 + 0.018; // keep the night blacks legible
        c = mix(c, s, uAmount);
        float d = length(vUv - 0.5);
        c *= 1.0 - uVignette * smoothstep(0.38, 0.85, d);
        gl_FragColor = vec4(c, src.a);
      }`
  };

  function buildPost() {
    if (composer) { composer.dispose(); composer = null; }
    gradePass = null;
    if (!needsPost()) return;
    const P = root.SpotKickPost;
    if (!P) return; // addons not loaded (yet): direct render; rebuilt when they arrive
    try {
      const w = view.w, h = view.h, pw = Math.max(1, Math.round(w * pixelRatio)), ph = Math.max(1, Math.round(h * pixelRatio));
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: gfx.antialias === 'msaa' ? 4 : 0
      });
      const c = new P.EffectComposer(renderer, target);
      c.setPixelRatio(pixelRatio);
      c.setSize(w, h);
      c.addPass(new P.RenderPass(scene, camera));
      if (gfx.bloom === 'on') {
        // high threshold: only lamp banks and bright highlights bloom
        c.addPass(new P.UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.45, 0.92));
      }
      c.addPass(new P.OutputPass());
      if (gfx.grade === 'on') {
        gradePass = new P.ShaderPass(GradeShader);
        c.addPass(gradePass);
      }
      if (gfx.antialias === 'smaa') c.addPass(new P.SMAAPass(pw, ph));
      if (gfx.antialias === 'fxaa') {
        const fxaa = new P.ShaderPass(P.FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        c.addPass(fxaa);
      }
      composer = c;
    } catch (e) {
      // post-processing is an enhancement: render directly and say so in the panel
      postFailed = true;
      if (composer) { try { composer.dispose(); } catch (_) {} }
      composer = null;
    }
  }

  // Adaptive resolution: average ~90 frames, step down when slow, back up when fast.
  function adapt(dt) {
    frameTimes.push(dt);
    if (frameTimes.length < 90) return;
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    frameTimes.length = 0;
    fps = 1000 / avg;
    const el = typeof document !== 'undefined' ? document.getElementById('fps-meter') : null;
    if (el && !el.classList.contains('hidden')) el.textContent = Math.round(fps) + ' fps · ' + (Math.round(pixelRatio * 100) / 100) + '×';
    if (!gfx.adaptive) return;
    const next = GFX.adaptStep(adaptiveScale, avg);
    if (next !== adaptiveScale) { adaptiveScale = next; sizeDirty = true; }
  }

  function applySize() {
    const ratio = Math.min(view.dpr || 1, gfx.cap) * gfx.scale * adaptiveScale;
    pixelRatio = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(view.w, view.h, false);
    sizeDirty = false;
  }

  // ---------- main loop hooks ----------
  function resize(w, h, dpr) {
    if (!renderer) return;
    view = { w: Math.max(1, w), h: Math.max(1, h), dpr: dpr || 1 };
    applySize();
    camera.aspect = view.w / view.h;
    camera.updateProjectionMatrix();
    applyViewOffset();
    if (built) setView(currentView, true); // refit for the new aspect
  }

  function renderFrame(now) {
    if (!renderer || !built || !webglOk) return;
    const dt = lastNow ? Math.min(250, Math.max(0, now - lastNow)) : 16;
    lastNow = now;
    adapt(dt);
    if (sizeDirty) applySize();
    updateAnim(now);
    updateCamera(now);
    updateAmbient(dt);
    const key = currentPostKey();
    if (key !== postKey) { postKey = key; buildPost(); }
    if (composer) {
      try { composer.render(dt / 1000); }
      catch (_) { postFailed = true; composer.dispose(); composer = null; postKey = null; renderer.render(scene, camera); }
    } else renderer.render(scene, camera);
  }

  function getQuality() { return gfx.preset; }

  function setReducedMotion(v) { reducedMotion = !!v; if (reducedMotion) shakeAmp = 0; }
  function setTheme(themeDef) { buildScene(themeDef); setView('shoot', true); }

  /** Canvas-space centre of a goal zone under the live camera (for tests/tools). */
  function zoneScreenPos(zone) {
    if (!camera || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const v = zoneCenter(zone).project(camera);
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  // deterministic per-tier diagnostics for validation captures
  function stats() {
    if (!renderer) return null;
    const i = renderer.info;
    return { drawCalls: i.render.calls, triangles: i.render.triangles, quality: gfx.preset,
      pixelRatio: Math.round(pixelRatio * 100) / 100, post: !!composer,
      cam: camera ? camera.position.toArray().map(n => +n.toFixed(2)) : null,
      view: camera && camera.view ? [camera.view.offsetX, camera.view.offsetY, camera.view.width, camera.view.height, camera.view.fullWidth, camera.view.fullHeight] : null,
      insets: safeInsets };
  }

  return {
    FRAME: FRAME,
    init: init, isWebglOk: isWebglOk,
    setTheme: setTheme, setGraphics: setGraphics, graphicsInfo: graphicsInfo, getQuality: getQuality,
    setReducedMotion: setReducedMotion,
    setView: setView, playKick: playKick, skip: skip, resetPositions: resetPositions,
    showZoneHighlight: showZoneHighlight, setInteractive: setInteractive,
    resize: resize, setSafeInsets: setSafeInsets, renderFrame: renderFrame, stats: stats,
    zoneScreenPos: zoneScreenPos
  };
});
