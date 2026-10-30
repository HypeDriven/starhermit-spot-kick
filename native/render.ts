// The night stadium on starhermit:scene, as the browser build's js/render.js
// drew it with three.js r160: the goal (clear-coated posts and bar, back
// stanchions, the fine or coarse net), the six pick zones and the selected
// zone's translucent fill and outline, the keeper (kit, shorts, socks, head,
// hair, gloves, arms up and out) with his idle sway, the panel ball, the
// mowing-striped pitch with its markings and penalty arc, soft contact blobs,
// the stepped terraces with the instanced crowd in supporter colours bobbing
// (a vertex hook, render.js's onBeforeCompile), the dim LED boards, the four
// floodlight towers with HDR lamp banks, and the floodlight atmosphere (lamp
// halos, additive light shafts — render.js's ShaderMaterial as WGSL — and
// drifting motes). Graphics follow the runtime's quality tier
// (native/quality.ts: gfx.js's presets and budgets).
//
// From three.js r160 (physically based lights): colours as written, the
// light intensities, shadow box and normalBias as the page (minor 29). render.js's `new RoomEnvironment(renderer)` (the r160 call)
// is kept exactly, carried by every lit material as its own envMap at its
// envMapIntensity (as r160 applied scene.environment). The old composer
// (RenderPass in half floats → UnrealBloom 0.55 / 0.45 / 0.92 → OutputPass
// with ACES at exposure 1.05 → the display-space grade + vignette → SMAA /
// FXAA) is the runtime's renderer.bloom / grade / antialias.
//
// The kick, the camera swing and the shake run on the fixed steps (step()),
// so a resolution always takes the same steps and play scripts replay
// exactly; only the cosmetic ambience (crowd bob, motes, halos, idle sway)
// follows frame time. The old canvas filled the window with the goal framed
// between the HUD bands: the camera's view offset frames it in the play rect.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CapsuleGeometry, CircleGeometry, Color,
  CylinderGeometry, DirectionalLight, DoubleSide, EdgesGeometry, ExtrudeGeometry, Float32BufferAttribute, Fog, Group, HemisphereLight,
  InstancedMesh, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, PMREMGenerator, PerspectiveCamera, PlaneGeometry, Points, PointsMaterial, Raycaster, RepeatWrapping, RingGeometry,
  OrthographicCamera, RoomEnvironment, SRGBColorSpace, ShaderMaterial, Shape, SphereGeometry, Sprite, SpriteMaterial, Vector2, Vector3, Vector4, pointerToNdc,
  renderer, scene, type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import type { KickEvent, Theme, Zone } from "./classic.ts";
import { crowdCount, MOTE_MAX, CROWD_MAX, CROWD_SPARSE, type Look } from "./quality.ts";

/** render.js FRAME: framing constants. */
export const FRAME = {
  GOAL_W: 7.32, GOAL_H: 2.44, BALL_R: 0.22,
  SPOT: { x: 0, y: 0.22, z: 11 }, GOAL_Z: 0,
  CAM_SHOOT: { x: 0, y: 2.6, z: 17.5, lx: 0, ly: 1.4, lz: 0 },
  CAM_KEEP: { x: 0, y: 2.4, z: -9.5, lx: 0, ly: 1.3, lz: 11 },
  CAM_TRANS_MS: 900,
  PLAY_CENTER: { x: 0, z: 5.5 },
  PLAY_HALF: 8.5,
};
export interface Rect { x: number; y: number; width: number; height: number }
const COLS = ["left", "center", "right"] as const;

// ---------------------------------------------------------------- canvases (render.js, unchanged drawing)
type Ctx = OffscreenCanvasRenderingContext2D;
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const hex = (c: number | Color): string => "#" + new Color(c).getHex().toString(16).padStart(6, "0");
function shade(c: number, k: number): string { const col = new Color(c); col.multiplyScalar(k); return hex(col); }
function canvasTex(w: number, h: number, paint: (g: Ctx, w: number, h: number) => void, srgb = true): CanvasTexture {
  const c = new OffscreenCanvas(w, h);
  paint(c.getContext("2d")! as Ctx, w, h);
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------- state
const camera = new PerspectiveCamera(46, 16 / 9, 0.1, 220);
const raycaster = new Raycaster();
const ndc = new Vector2();
let theme: Theme | null = null;
let look: Look | null = null;
let built: Look["budget"] | null = null;
let root: Group | null = null;
let keyLight: DirectionalLight | null = null, hemi: HemisphereLight | null = null;
let keeper: Group | null = null, keeperRig: Group | null = null, ball: Mesh | null = null;
let netPlain: LineSegments | null = null, netDetail: LineSegments | null = null;
let crowd: InstancedMesh | null = null, crowdFull: BufferGeometry | null = null, crowdSparse: BufferGeometry | null = null;
let atmosphere: Group | null = null, motes: Points | null = null;
let halos: Sprite[] = [];
let ballBlob: Mesh | null = null, keeperBlob: Mesh | null = null;
let zoneHighlight: Mesh | null = null;
let mats: { pitch?: MeshStandardMaterial | MeshLambertMaterial; ball?: MeshStandardMaterial | MeshLambertMaterial } = {};
let tex: Record<string, CanvasTexture> = {};
let litMats: Material[] = [];
let disposables: { dispose(): void }[] = [];
let envTex: Texture | null = null;
let reducedMotion = false;
const U = { uTime: { value: 0 }, uBob: { value: 0 } };
const keeperHome = new Vector3(0, 0, FRAME.GOAL_Z + 0.4);
const ballHome = new Vector3(FRAME.SPOT.x, FRAME.SPOT.y, FRAME.SPOT.z);
let moteBase = new Float32Array(0);
let shakeRnd = lcg(0x5a4e);

function track<T extends { dispose(): void }>(o: T): T { disposables.push(o); return o; }

function environment(): Texture | null {
  if (!envTex) {
    try {
      const pm = new PMREMGenerator(renderer);
      envTex = pm.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    } catch (e) { console.warn(`environment: ${String(e)}`); }
  }
  return envTex;
}

interface Params {
  color?: number | Color; roughness?: number; metalness?: number; clearcoat?: number; clearcoatRoughness?: number; envMapIntensity?: number;
  map?: Texture | null; polygonOffset?: boolean; polygonOffsetFactor?: number; polygonOffsetUnits?: number;
}
/** render.js litMat: Lambert (Low), Standard (Balanced), Physical clear-coated posts, ball and gloves (High, Ultra). */
function litMat(p: Params, physical = false): MeshStandardMaterial | MeshLambertMaterial {
  const tier = built!.material;
  const { roughness, metalness, clearcoat, clearcoatRoughness, envMapIntensity, ...base } = p;
  let m: MeshStandardMaterial | MeshLambertMaterial;
  if (tier === "lambert") m = new MeshLambertMaterial(base);
  else if (physical && tier === "physical") {
    m = new MeshPhysicalMaterial({ ...base, roughness: roughness ?? 1, metalness: metalness ?? 0, clearcoat: clearcoat ?? 0, clearcoatRoughness: clearcoatRoughness ?? 0 });
  } else m = new MeshStandardMaterial({ ...base, roughness: roughness ?? 1, metalness: metalness ?? 0 });
  if (m instanceof MeshStandardMaterial) m.envMapIntensity = envMapIntensity ?? 1;
  litMats.push(m);
  return track(m);
}
const sg = (n: number, min = 3): number => Math.max(min, Math.round(n * built!.seg));

// static batching: one draw call per material for fixed props (render.js addStatic / flushStatics)
let statics = new Map<Material, Mesh[]>();
function addStatic(m: Mesh): void {
  const mat = m.material as Material;
  if (!statics.has(mat)) statics.set(mat, []);
  statics.get(mat)!.push(m);
}
function mergeMeshes(list: Mesh[], mat: Material): Mesh {
  const geos = list.map((m) => {
    m.updateMatrixWorld(true);
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    return g;
  });
  const merged = new BufferGeometry();
  for (const name of ["position", "normal", "uv"] as const) {
    if (!geos.every((g) => g.getAttribute(name))) continue;
    const size = geos[0]!.getAttribute(name)!.itemSize;
    const total = geos.reduce((n, g) => n + (g.getAttribute(name)!.array as Float32Array).length, 0);
    const arr = new Float32Array(total);
    let off = 0;
    for (const g of geos) { const a = g.getAttribute(name)!.array as Float32Array; arr.set(a, off); off += a.length; }
    merged.setAttribute(name, new Float32BufferAttribute(arr, size));
  }
  for (const g of geos) g.dispose();
  for (const m of list) m.geometry.dispose();
  const mesh = new Mesh(track(merged), mat);
  mesh.castShadow = list.some((m) => m.castShadow);
  mesh.receiveShadow = list.some((m) => m.receiveShadow);
  return mesh;
}
function flushStatics(): void {
  for (const [mat, list] of statics) root!.add(mergeMeshes(list, mat));
  statics = new Map();
}

// ---------------------------------------------------------------- building (render.js buildScene)
/** Builds the stadium for a theme with the current look's budget; the ball and keeper keep their places. */
export function build(t: Theme): void {
  theme = t;
  if (!look) return;
  const keep = ball && keeper ? { b: ball.position.clone(), br: ball.rotation.x, k: keeper.position.clone(), kr: keeper.rotation.z } : null;
  if (root) { scene.remove(root); }
  for (const d of disposables) d.dispose();
  disposables = [];
  litMats = [];
  halos = [];
  mats = {};
  tex = {};
  built = look.budget;
  root = new Group();
  const horizon = new Color(t.sky).lerp(new Color(t.accent), 0.12).multiplyScalar(1.9);
  tex.sky = track(canvasTex(4, 256, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, shade(t.sky, 0.55));
    grad.addColorStop(0.55, hex(t.sky));
    grad.addColorStop(1, hex(horizon));
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  }));
  scene.background = tex.sky;
  scene.fog = new Fog(horizon, 40, 140);

  // lighting: one dominant key (floodlight bank) + hemisphere fill + accent rim (r160 intensities as written)
  keyLight = new DirectionalLight(0xfff4e2, 2.0);
  keyLight.target.position.set(FRAME.PLAY_CENTER.x, 0, FRAME.PLAY_CENTER.z);
  keyLight.position.set(7, 15, 13);
  keyLight.shadow.bias = -0.0004;
  const sc = keyLight.shadow.camera as OrthographicCamera;
  sc.left = -FRAME.PLAY_HALF; sc.right = FRAME.PLAY_HALF; sc.top = FRAME.PLAY_HALF; sc.bottom = -FRAME.PLAY_HALF;
  sc.near = 4; sc.far = 40;
  sc.updateProjectionMatrix();
  keyLight.shadow.normalBias = 0.02;
  keyLight.shadow.radius = 3;
  hemi = new HemisphereLight(0x9ab8ff, 0x0c1410, 0.55);
  const rim = new DirectionalLight(t.accent, 0.7);
  rim.position.set(-8, 6, -6);
  const back = new DirectionalLight(0xdfe6ff, 0.5); // opposite floodlight bank
  back.position.set(-6, 12, -10);
  root.add(keyLight, keyLight.target, hemi, rim, back);

  buildPitch(t);
  buildGoal(t);
  buildKeeper(t);
  buildBall();
  buildStands(t);
  buildZoneHighlight(t);
  flushStatics();
  scene.add(root);
  if (keep) {
    ball!.position.copy(keep.b); ball!.rotation.x = keep.br;
    keeper!.position.copy(keep.k); keeper!.rotation.z = keep.kr;
  }
  applyQuality();
  setView(currentView, true);
}

function buildPitch(t: Theme): void {
  const pz = built!.pitch;
  tex.pitch = track(canvasTex(pz, pz, (g, w, h) => {
    g.scale(w / 256, h / 256); w = 256; h = 256;
    const rnd = lcg(0x51a7);
    for (let b = 0; b < 2; b++) {
      g.fillStyle = shade(t.pitch, b ? 1.16 : 0.9);
      g.fillRect(0, (b * h) / 2, w, h / 2);
    }
    for (let i = 0; i < 9000; i++) {
      const v = rnd();
      g.fillStyle = v > 0.5 ? "rgba(255,255,255,0.028)" : "rgba(0,0,0,0.04)";
      g.fillRect(rnd() * w, rnd() * h, 1, 1 + rnd() * 2);
    }
  }));
  tex.pitch.wrapS = tex.pitch.wrapT = RepeatWrapping;
  tex.pitch.repeat.set(8, 12);
  mats.pitch = litMat({ color: t.pitch, roughness: 0.95, metalness: 0, envMapIntensity: 0.15 });
  const pitch = new Mesh(track(new PlaneGeometry(80, 120)), mats.pitch);
  pitch.rotation.x = -Math.PI / 2;
  pitch.position.z = 20;
  pitch.receiveShadow = true;
  root!.add(pitch);

  // pitch markings (lit, so they sit in the scene rather than glow)
  const lineMat = litMat({ color: t.line, roughness: 0.8, envMapIntensity: 0.1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const addLine = (w: number, h: number, x: number, z: number): void => {
    const m = new Mesh(new PlaneGeometry(w, h), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.01, z);
    m.receiveShadow = true;
    addStatic(m);
  };
  addLine(0.1, 16.5, -9.15, 8.25); addLine(0.1, 16.5, 9.15, 8.25);
  addLine(18.3, 0.1, 0, 16.5);
  addLine(0.1, 5.5, -4.6, 2.75); addLine(0.1, 5.5, 4.6, 2.75); addLine(9.2, 0.1, 0, 5.5);
  addLine(60, 0.1, 0, 0); // goal line
  const spot = new Mesh(new CircleGeometry(0.12, sg(20, 10)), lineMat);
  spot.rotation.x = -Math.PI / 2; spot.position.set(0, 0.012, 11); spot.receiveShadow = true;
  addStatic(spot);
  const arc = new Mesh(new RingGeometry(9.1, 9.2, sg(48, 24), 1, Math.PI * 1.29, Math.PI * 0.42), lineMat);
  arc.rotation.x = -Math.PI / 2; arc.position.set(0, 0.011, 11); arc.receiveShadow = true;
  addStatic(arc);

  // soft contact blobs: grounding that works with shadows disabled
  tex.blob = track(canvasTex(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, "rgba(0,0,0,0.85)"); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }, false));
  const blobMat = (): MeshBasicMaterial => track(new MeshBasicMaterial({ map: tex.blob!, color: 0xffffff, transparent: true, depthWrite: false, opacity: 0.55 }));
  const blobGeo = track(new PlaneGeometry(1, 1));
  ballBlob = new Mesh(blobGeo, blobMat());
  ballBlob.rotation.x = -Math.PI / 2;
  keeperBlob = new Mesh(blobGeo, blobMat());
  keeperBlob.rotation.x = -Math.PI / 2;
  keeperBlob.scale.set(1.1, 0.7, 1);
  root!.add(ballBlob, keeperBlob);
}

/** Grid of line segments across a quad (corners a, b, c, d in order), n × m cells (render.js gridLines). */
function gridLines(pts: number[], a: Vector3, b: Vector3, c: Vector3, d: Vector3, n: number, m: number, sag: number): void {
  const P = (u: number, v: number): Vector3 => {
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
function buildNet(cell: number, opacity: number): LineSegments {
  const W = FRAME.GOAL_W / 2, H = FRAME.GOAL_H;
  const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
  const topBack = -1.0, botBack = -2.0, backTop = H - 0.25;
  const pts: number[] = [];
  const nx = Math.round(FRAME.GOAL_W / cell), ny = Math.round(H / cell), nz = Math.max(3, Math.round(2 / cell));
  gridLines(pts, V(-W, backTop, topBack), V(W, backTop, topBack), V(W, 0, botBack), V(-W, 0, botBack), nx, ny, 0.12); // back
  gridLines(pts, V(-W, H, 0), V(W, H, 0), V(W, backTop, topBack), V(-W, backTop, topBack), nx, Math.max(2, Math.round(1 / cell)), 0); // roof
  for (const s of [-1, 1]) gridLines(pts, V(s * W, H, 0), V(s * W, backTop, topBack), V(s * W, 0, botBack), V(s * W, 0, 0), nz, ny, 0); // sides
  const g = track(new BufferGeometry());
  g.setAttribute("position", new Float32BufferAttribute(pts, 3));
  return new LineSegments(g, track(new LineBasicMaterial({ color: 0xd4dcea, transparent: true, opacity })));
}
function buildGoal(_t: Theme): void {
  const post = litMat({ color: 0xf4f6fa, roughness: 0.32, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 0.6 }, true);
  const postR = 0.06;
  const mk = (geo: BufferGeometry, x: number, y: number, z: number, rz = 0): void => {
    const m = new Mesh(geo, post);
    m.position.set(x, y, z); m.rotation.z = rz; m.castShadow = true; m.receiveShadow = true;
    addStatic(m);
  };
  mk(new CylinderGeometry(postR, postR, FRAME.GOAL_H, sg(16, 8)), -FRAME.GOAL_W / 2, FRAME.GOAL_H / 2, FRAME.GOAL_Z);
  mk(new CylinderGeometry(postR, postR, FRAME.GOAL_H, sg(16, 8)), FRAME.GOAL_W / 2, FRAME.GOAL_H / 2, FRAME.GOAL_Z);
  mk(new CylinderGeometry(postR, postR, FRAME.GOAL_W + postR * 2, sg(16, 8)), 0, FRAME.GOAL_H, FRAME.GOAL_Z, Math.PI / 2);
  const stMat = litMat({ color: 0x9aa4b4, roughness: 0.5, metalness: 0.6 });
  for (const s of [-1, 1]) {
    const st = new Mesh(new CylinderGeometry(0.025, 0.025, 2.4, 6), stMat);
    st.position.set((s * FRAME.GOAL_W) / 2, 1.1, -1.5); st.rotation.x = 0.43;
    addStatic(st);
  }
  netPlain = buildNet(0.61, 0.35);
  netDetail = buildNet(0.2, 0.3);
  root!.add(netPlain, netDetail);
}

function buildKeeper(t: Theme): void {
  keeper = new Group();
  keeperRig = new Group(); // idle motion lives here, never on the logical root
  const kit = litMat({ color: t.accent, roughness: 0.55, envMapIntensity: 0.4 });
  const dark = litMat({ color: 0x151c2b, roughness: 0.7, envMapIntensity: 0.3 });
  const skin = litMat({ color: 0xd9b38c, roughness: 0.7, envMapIntensity: 0.3 });
  const glove = litMat({ color: 0xf2f4f8, roughness: 0.45, clearcoat: 0.5, envMapIntensity: 0.5 }, true);
  const body = new Mesh(new CapsuleGeometry(0.22, 0.5, sg(4, 2), sg(14, 8)), kit);
  body.position.y = 1.08;
  const shorts = new Mesh(new CylinderGeometry(0.235, 0.24, 0.26, sg(14, 8)), dark);
  shorts.position.y = 0.72;
  const head = new Mesh(track(new SphereGeometry(0.16, sg(18, 10), sg(14, 8))), skin);
  head.position.y = 1.62;
  const hair = new Mesh(new SphereGeometry(0.165, sg(16, 10), sg(8, 5), 0, Math.PI * 2, 0, Math.PI * 0.45), dark);
  hair.position.y = 1.63;
  const armGeo = track(new CapsuleGeometry(0.06, 0.5, sg(3, 2), sg(10, 6)));
  const handGeo = track(new SphereGeometry(0.085, sg(12, 8), sg(10, 6)));
  const arms: Group[] = [];
  for (const s of [-1, 1]) {
    const pivot = new Group(); pivot.position.set(s * 0.25, 1.36, 0);
    const arm = new Mesh(armGeo, kit); arm.position.y = -0.28;
    const hand = new Mesh(handGeo, glove); hand.position.y = -0.6;
    pivot.add(arm, hand); pivot.rotation.z = s * 2.4; // arms up and out, ready
    pivot.userData.base = pivot.rotation.z;
    arms.push(pivot);
  }
  const legGeo = (): CapsuleGeometry => new CapsuleGeometry(0.08, 0.5, sg(3, 2), sg(10, 6));
  const legL = new Mesh(legGeo(), dark); legL.position.set(-0.12, 0.36, 0);
  const legR = new Mesh(legGeo(), dark); legR.position.set(0.12, 0.36, 0);
  const sockGeo = (): CylinderGeometry => new CylinderGeometry(0.085, 0.08, 0.26, sg(10, 6));
  const sockL = new Mesh(sockGeo(), kit); sockL.position.set(-0.12, 0.2, 0);
  const sockR = new Mesh(sockGeo(), kit); sockR.position.set(0.12, 0.2, 0);
  keeperRig.add(mergeMeshes([body, sockL, sockR], kit), mergeMeshes([shorts, hair, legL, legR], dark), head, ...arms);
  keeperRig.userData.arms = arms;
  keeper.add(keeperRig);
  keeper.position.copy(keeperHome);
  keeper.traverse((o: Object3D) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
  root!.add(keeper);
}

function buildBall(): void {
  tex.ball = track(canvasTex(built!.ball, built!.ball / 2, (g, w, h) => { // authored at 512×256
    g.scale(w / 512, h / 256); w = 512; h = 256;
    g.fillStyle = "#f4f6fb"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#1b2233";
    const poly = (cx: number, cy: number, r: number, n: number, rot: number): void => {
      g.beginPath();
      for (let k = 0; k < n; k++) {
        const a = rot + (k * Math.PI * 2) / n;
        g.lineTo(cx + Math.cos(a) * r * 1.6, cy + Math.sin(a) * r);
      }
      g.closePath(); g.fill();
    };
    poly(w / 2, 6, 20, 5, 0); poly(w / 2, h - 6, 20, 5, Math.PI);
    for (let k = 0; k < 5; k++) {
      poly(((k + 0.1) * w) / 5, h * 0.3, 22, 5, -Math.PI / 2);
      poly(((k + 0.6) * w) / 5, h * 0.7, 22, 5, Math.PI / 2);
    }
    g.strokeStyle = "rgba(40,50,70,0.35)"; g.lineWidth = 2;
    for (let k = 0; k < 10; k++) { g.beginPath(); g.moveTo((k * w) / 10, 0); g.lineTo((k * w) / 10 + 12, h); g.stroke(); }
  }));
  mats.ball = litMat({ color: 0xdfe3ea, roughness: 0.5, clearcoat: 0.5, clearcoatRoughness: 0.25, envMapIntensity: 0.4 }, true);
  ball = new Mesh(track(new SphereGeometry(FRAME.BALL_R, sg(32, 16), sg(22, 11))), mats.ball);
  ball.castShadow = true;
  ball.position.copy(ballHome);
  root!.add(ball);
}

/** Stepped terrace profile extruded along x (render.js terraceGeo). */
function terraceGeo(rows: number, rise: number, run: number): ExtrudeGeometry {
  const shape = new Shape();
  shape.moveTo(0, 0);
  for (let r = 0; r < rows; r++) { shape.lineTo(r * run, (r + 1) * rise); shape.lineTo((r + 1) * run, (r + 1) * rise); }
  shape.lineTo(rows * run, 0);
  shape.lineTo(0, 0);
  const g = new ExtrudeGeometry(shape, { depth: 48, bevelEnabled: false });
  g.translate(0, 0, -24);
  g.rotateY(Math.PI / 2);
  return g;
}
// The crowd's bob (render.js onBeforeCompile on the crowd material): a per-supporter phase in instance slot 0.
const CROWD_HOOKS = {
  uniforms: U,
  vertex: `fn vertex(v: Vertex) -> Vertex {
    var o = v;
    let ph = v.instance.x;
    o.position.y = o.position.y + uniforms.uBob * 0.09 * max(0.0, sin(uniforms.uTime * (2.2 + ph) + ph * 6.2831));
    return o;
  }`,
};
// The light shafts (render.js beamMaterial's GLSL as WGSL): brightest near the lamp, fading at silhouette edges.
const BEAM_VERTEX = `fn vertex(v: Vertex) -> Vertex {
  var o = v;
  o.v0 = vec4f(v.position.y, 0.0, 0.0, 0.0);
  return o;
}`;
const BEAM_FRAGMENT = `fn fragment(f: Fragment) -> vec4f {
  let n = normalize(f.normal);
  let vv = normalize(camera_position() - f.world);
  let edge = pow(abs(dot(n, vv)), 2.0);
  let along = clamp(f.v0.x * 0.06 + 0.55, 0.0, 1.0);
  return vec4f(uniforms.uColor * uniforms.uOpacity * edge * along, 1.0);
}`;

function buildStands(t: Theme): void {
  const standMat = litMat({ color: 0x141d31, roughness: 0.95, envMapIntensity: 0.1 });
  const ROWS = 11, RISE = 0.75, RUN = 0.9;
  const stands = [{ z: -12.1, dir: -1 }, { z: 38, dir: 1 }];
  for (const s of stands) {
    const m = new Mesh(terraceGeo(ROWS, RISE, RUN), standMat);
    m.position.set(0, 0.2, s.z);
    if (s.dir > 0) m.rotation.y = Math.PI;
    addStatic(m);
    const roof = new Mesh(new BoxGeometry(48, 0.25, 5), standMat);
    roof.position.set(0, ROWS * RISE + 3.2, s.z + s.dir * (ROWS * RUN - 2));
    addStatic(roof);
  }
  // perimeter LED boards behind the goal (dim, so the goalmouth stays clear)
  tex.boards = track(canvasTex(1024, 32, (g, w, h) => {
    g.fillStyle = "#0a1122"; g.fillRect(0, 0, w, h);
    g.font = "bold 22px sans-serif"; g.textBaseline = "middle";
    for (let i = 0; i < 6; i++) {
      g.fillStyle = i % 2 ? hex(t.accent) : "#cfd8ea";
      g.fillText("SPOT KICK", i * 172 + 20, h / 2 + 1);
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.fillRect(i * 172 + 150, 8, 4, 16);
    }
  }));
  const boards = new Mesh(track(new PlaneGeometry(34, 0.8)), track(new MeshBasicMaterial({ map: tex.boards, color: 0x3c4352 })));
  boards.position.set(0, 0.4, -7.2);
  root!.add(boards);

  // crowd: low-poly supporters with per-instance kit colours and a gentle bob
  crowdFull = track(new CapsuleGeometry(0.15, 0.32, 2, 6));
  crowdSparse = track(new CylinderGeometry(0.13, 0.16, 0.62, 5, 1)); // sparse tier: ~20 triangles
  const crowdMat = built!.material === "lambert"
    ? new MeshLambertMaterial({ color: 0xffffff, hooks: CROWD_HOOKS })
    : new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, envMapIntensity: 0.1, hooks: CROWD_HOOKS });
  litMats.push(track(crowdMat));
  crowd = new InstancedMesh(crowdFull, crowdMat, CROWD_MAX);
  crowd.customSlots = 1;
  const m = new Matrix4();
  const rnd = lcg(0x1234abcd); // decoration stream
  const palette = [new Color(t.accent), new Color(0xe8edf5), new Color(0x26324a), new Color(t.accent).multiplyScalar(0.6), new Color(0x3b465e)];
  const col = new Color();
  const v4 = new Vector4();
  // every seat of both stands, shuffled per stand so any prefix is an even scatter
  const perStand = CROWD_MAX / 2, perRow = Math.ceil(perStand / ROWS);
  const seats = stands.map((st) => {
    const list: { st: typeof st; row: number; slot: number }[] = [];
    for (let k = 0; k < perStand; k++) list.push({ st, row: k % ROWS, slot: (k / ROWS) | 0 });
    for (let k = list.length - 1; k > 0; k--) { const j = (rnd() * (k + 1)) | 0; const tmp = list[k]!; list[k] = list[j]!; list[j] = tmp; }
    return list;
  });
  // the sparse prefix favours the stand behind the goal (the one the shooter sees)
  const goalFirst = Math.round(CROWD_SPARSE * 0.72);
  const order = seats[0]!.slice(0, goalFirst).concat(seats[1]!.slice(0, CROWD_SPARSE - goalFirst), seats[0]!.slice(goalFirst), seats[1]!.slice(CROWD_SPARSE - goalFirst));
  order.forEach((seat, i) => {
    const x = -21.5 + (seat.slot / perRow) * 43 + (rnd() - 0.5) * 0.25;
    const y = 0.2 + (seat.row + 1) * RISE + 0.33 + rnd() * 0.06;
    const z = seat.st.z + seat.st.dir * (seat.row * RUN + RUN * 0.5);
    m.makeTranslation(x, y, z);
    crowd!.setMatrixAt(i, m);
    col.copy(palette[(rnd() * palette.length) | 0]!).multiplyScalar(0.75 + rnd() * 0.35);
    crowd!.setColorAt(i, col);
    crowd!.setCustomAt(i, v4.set(rnd(), 0, 0, 0));
  });
  crowd.frustumCulled = false;
  root!.add(crowd);

  // floodlight towers: lamp banks are HDR emitters (they bloom when bloom is on)
  tex.lamps = track(canvasTex(128, 64, (g, w, h) => {
    g.fillStyle = "#2a2f3a"; g.fillRect(0, 0, w, h);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) {
      const gr = g.createRadialGradient(10 + c * 21.6, 11 + r * 21, 1, 10 + c * 21.6, 11 + r * 21, 9);
      gr.addColorStop(0, "#ffffff"); gr.addColorStop(0.6, "#fff3d6"); gr.addColorStop(1, "#6d6656");
      g.fillStyle = gr; g.beginPath(); g.arc(10 + c * 21.6, 11 + r * 21, 8.5, 0, Math.PI * 2); g.fill();
    }
  }));
  const lampMat = track(new MeshBasicMaterial({ map: tex.lamps, color: new Color(0xfff6da).multiplyScalar(3.2), fog: false }));
  const towerMat = litMat({ color: 0x2a3144, roughness: 0.6, metalness: 0.5 });
  tex.halo = track(canvasTex(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.25, "rgba(255,240,210,0.45)"); gr.addColorStop(1, "rgba(255,240,210,0)");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }));
  atmosphere = new Group();
  const lamps: { lamp: Vector3; target: Vector3; panel: Mesh }[] = [];
  for (const z of [-8, 28]) {
    for (const x of [-15, 15]) {
      const tower = new Mesh(new CylinderGeometry(0.16, 0.26, 14, 8), towerMat);
      tower.position.set(x, 7, z);
      addStatic(tower);
      const lampPos = new Vector3(x, 14.2, z);
      const panel = new Mesh(new PlaneGeometry(2.6, 1.3), lampMat);
      panel.position.copy(lampPos);
      panel.lookAt(0, 0, 6);
      addStatic(panel);
      const backing = new Mesh(new BoxGeometry(2.8, 1.5, 0.2), towerMat);
      backing.position.copy(lampPos); backing.quaternion.copy(panel.quaternion); backing.translateZ(-0.12);
      addStatic(backing);
      lamps.push({ lamp: lampPos, target: new Vector3(x * 0.2, 0, z < 0 ? 4 : 8), panel });
    }
  }
  const beamGeoCache: BufferGeometry[] = [];
  for (const L of lamps) {
    const halo = new Sprite(track(new SpriteMaterial({ map: tex.halo, color: 0xfff1d0, blending: AdditiveBlending, transparent: true, depthWrite: false, fog: false, opacity: 0.75 })));
    halo.position.copy(L.lamp).addScaledVector(new Vector3(0, 0, 1).applyQuaternion(L.panel.quaternion), 0.2);
    halo.scale.setScalar(7);
    halos.push(halo);
    atmosphere.add(halo);
    const dir = L.lamp.clone().sub(L.target);
    const len = dir.length();
    const geo = track(new CylinderGeometry(0.9, 5.5, len, sg(28, 12), 1, true));
    beamGeoCache.push(geo);
    const beam = new Mesh(geo, track(new ShaderMaterial({
      uniforms: { uColor: { value: new Color(0xfff0d0) }, uOpacity: { value: 0.07 } },
      vertexShader: BEAM_VERTEX, fragmentShader: BEAM_FRAGMENT,
      transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
    })));
    beam.position.copy(L.lamp).add(L.target).multiplyScalar(0.5);
    beam.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
    beam.renderOrder = 2;
    atmosphere.add(beam);
  }
  const N = MOTE_MAX, pos = new Float32Array(N * 3);
  moteBase = new Float32Array(N * 3);
  const mr = lcg(0x77aa11);
  for (let i = 0; i < N; i++) {
    moteBase[i * 3] = (mr() - 0.5) * 24; moteBase[i * 3 + 1] = 0.4 + mr() * 9; moteBase[i * 3 + 2] = -4 + mr() * 20;
  }
  pos.set(moteBase);
  const mg = track(new BufferGeometry());
  mg.setAttribute("position", new BufferAttribute(pos, 3));
  motes = new Points(mg, track(new PointsMaterial({ color: 0xfff0cc, size: 0.035, map: tex.halo, transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.7 })));
  motes.frustumCulled = false;
  atmosphere.add(motes);
  root!.add(atmosphere);
}

function buildZoneHighlight(t: Theme): void {
  const w = FRAME.GOAL_W / 3 - 0.12, h = FRAME.GOAL_H / 2 - 0.1;
  const geo = track(new PlaneGeometry(w, h));
  zoneHighlight = new Mesh(geo, track(new MeshBasicMaterial({ color: t.accent, transparent: true, opacity: 0.3, side: DoubleSide, depthWrite: false })));
  // outline so selection never relies on a translucent fill alone
  zoneHighlight.add(new LineSegments(track(new EdgesGeometry(geo)), track(new LineBasicMaterial({ color: t.accent }))));
  zoneHighlight.visible = false;
  root!.add(zoneHighlight);
}

// ---------------------------------------------------------------- quality
/** The quality-dependent switches that need no rebuild (render.js applyGraphics). */
function applyQuality(): void {
  if (!look || !root) return;
  const size = look.shadows;
  renderer.shadowMap.enabled = size > 0;
  if (keyLight) { keyLight.castShadow = size > 0; if (size > 0) keyLight.shadow.mapSize = size; }
  const detailed = look.detailed;
  if (mats.pitch) { mats.pitch.map = detailed ? tex.pitch ?? null : null; mats.pitch.color.set(detailed ? 0xffffff : theme!.pitch); }
  if (mats.ball) mats.ball.map = detailed ? tex.ball ?? null : null;
  if (netPlain) netPlain.visible = !detailed;
  if (netDetail) netDetail.visible = detailed;
  if (crowd) {
    crowd.count = crowdCount(look);
    crowd.geometry = look.crowd === "full" ? crowdFull! : crowdSparse!;
  }
  // atmosphere stays off in the high-contrast theme so nothing hazes the goal
  if (atmosphere) atmosphere.visible = look.atmosphere && theme!.id !== "mono";
  if (motes) motes.geometry.setDrawRange(0, Math.min(MOTE_MAX, look.budget.motes));
  const env = look.reflections ? environment() : null;
  scene.environment = null;
  for (const m of litMats) if (m instanceof MeshStandardMaterial) m.envMap = env;
  if (hemi) hemi.intensity = env ? 0.35 : 0.55;
}

/** The runtime's quality tier applied live: the stadium rebuilds when its budget changes, else the switches. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  look = next;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  // UnrealBloomPass(0.55, 0.45, 0.92) of r160 (bloom.model "r160", the page's strength), on the linear half floats: only lamp banks and bright highlights bloom.
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.55, radius: 0.45, threshold: 0.92, resolution: next.budget.bloomRes } : null;
  // GradeShader after OutputPass (display space): a 0.22 S-curve, saturation 1.1, cool shadows / warm floodlit
  // highlights by a smoothstep of luma from 0.25 to 0.85, s × 0.975 + 0.018 (levels), a 0.26 vignette from 0.38 to 0.85.
  renderer.grade = next.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.22, saturation: 1.1, split: [0.25, 0.85], shadows: [0.95, 0.98, 1.06], highlights: [1.04, 1.01, 0.96],
    levels: [0.975, 0.018],
    vignette: { amount: 0.26, inner: 0.38, outer: 0.85 },
  } : null;
  renderer.antialias = next.antialias;
  const rebuild = !prev || !root || (["material", "pitch", "ball", "seg"] as const).some((k) => prev.budget[k] !== next.budget[k]);
  if (theme && rebuild) build(theme);
  else applyQuality();
}
export function setReducedMotion(v: boolean): void { reducedMotion = v; if (v) shakeAmp = 0; }
/** Whether the stadium draws (hidden only while the runtime covers the window). */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

// ---------------------------------------------------------------- zones and picking
export function zoneCenter(zone: Zone): Vector3 {
  const ci = COLS.indexOf(zone.dir as (typeof COLS)[number]);
  const x = -FRAME.GOAL_W / 3 + (ci * FRAME.GOAL_W) / 3;
  const y = zone.height === "high" ? FRAME.GOAL_H * 0.75 : FRAME.GOAL_H * 0.25;
  return new Vector3(x, y, FRAME.GOAL_Z);
}
export function showZoneHighlight(zone: Zone | null): void {
  if (!zoneHighlight) return;
  if (!zone) { zoneHighlight.visible = false; return; }
  zoneHighlight.position.copy(zoneCenter(zone));
  zoneHighlight.position.z = FRAME.GOAL_Z - 0.04;
  zoneHighlight.visible = true;
}
const hitPoint = new Vector3();
/** The goal zone under a window point (render.js pickZone over the six double-sided zone planes), or null. */
export function pickZone(x: number, y: number): Zone | null {
  if (!renderer.camera) return null;
  pointerToNdc(x, y, ndc);
  raycaster.setFromCamera(ndc, camera);
  const r = raycaster.ray;
  const z = FRAME.GOAL_Z - 0.05;
  if (Math.abs(r.direction.z) < 1e-6) return null;
  const t = (z - r.origin.z) / r.direction.z;
  if (t <= 0) return null;
  hitPoint.copy(r.origin).addScaledVector(r.direction, t);
  const W = FRAME.GOAL_W / 2;
  if (hitPoint.x < -W || hitPoint.x > W || hitPoint.y < 0 || hitPoint.y > FRAME.GOAL_H) return null;
  const ci = Math.min(2, Math.floor(((hitPoint.x + W) / FRAME.GOAL_W) * 3));
  return { dir: COLS[ci]!, height: hitPoint.y >= FRAME.GOAL_H / 2 ? "high" : "low" };
}
/** A zone's box on screen (window px) for its named target. */
export function zoneScreenRect(zone: Zone): Rect {
  const c = zoneCenter(zone);
  const hw = FRAME.GOAL_W / 6 - 0.04, hh = FRAME.GOAL_H / 4 - 0.04;
  const pts = [new Vector3(c.x - hw, c.y - hh, 0), new Vector3(c.x + hw, c.y + hh, 0)].map((p) => {
    const v = p.project(camera);
    return { x: ((v.x + 1) / 2) * win.w, y: ((1 - v.y) / 2) * win.h };
  });
  const x0 = Math.min(pts[0]!.x, pts[1]!.x), x1 = Math.max(pts[0]!.x, pts[1]!.x), y0 = Math.min(pts[0]!.y, pts[1]!.y), y1 = Math.max(pts[0]!.y, pts[1]!.y);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// ---------------------------------------------------------------- camera (render.js setView / fittedTarget)
let currentView: "shoot" | "keep" = "shoot";
let win = { w: 1, h: 1 };
let view: Rect = { x: 0, y: 0, width: 1, height: 1 };
let uiScale = 1;
let look0 = new Vector3();
interface CamAnim { t: number; dur: number; fromPos: Vector3; fromLook: Vector3; toPos: Vector3; toLook: Vector3 }
let camAnim: CamAnim | null = null;
let shakeAmp = 0;
const shake = new Vector3();

function applyViewOffset(): void {
  const W = win.w, H = win.h;
  const left = view.x, top = view.y;
  const sw = Math.max(1, view.width), sh = Math.max(1, view.height);
  if (sw < W * 0.4 || sh < H * 0.28) { camera.aspect = W / H; camera.clearViewOffset(); }
  else { camera.aspect = sw / sh; camera.setViewOffset(sw, sh, -left, -top, W, H); }
  camera.updateProjectionMatrix();
}
function fittedTarget(v: "shoot" | "keep"): { pos: Vector3; look: Vector3 } {
  const t = v === "keep" ? FRAME.CAM_KEEP : FRAME.CAM_SHOOT;
  const pos = new Vector3(t.x, t.y, t.z), lk = new Vector3(t.lx, t.ly, t.lz);
  const probe = new PerspectiveCamera(camera.fov, camera.aspect || 1, 0.1, 220);
  const pad = 0.9;
  const pts: Vector3[] = [];
  for (const x of [-FRAME.GOAL_W / 2 - pad, FRAME.GOAL_W / 2 + pad]) for (const y of [-0.2, FRAME.GOAL_H + pad]) pts.push(new Vector3(x, y, FRAME.GOAL_Z));
  // the ball on the spot stays in frame too, except in very short views where the goal needs all the height
  const shortView = camera.view ? camera.view.fullHeight / uiScale < 300 : false;
  if (v !== "keep" && !shortView) pts.push(new Vector3(0, 0, FRAME.SPOT.z + 0.6));
  const dir = pos.clone().sub(lk).normalize();
  const q = new Vector3();
  const d0 = pos.distanceTo(lk);
  pos.copy(lk).addScaledVector(dir, d0 * 0.6);
  for (let i = 0; i < 16; i++) {
    probe.position.copy(pos); probe.lookAt(lk); probe.updateMatrixWorld(); probe.updateProjectionMatrix();
    let over = 0;
    for (const p of pts) { q.copy(p).project(probe); over = Math.max(over, Math.abs(q.x) / 0.95, Math.abs(q.y) / 0.92); }
    if (over <= 1) break;
    const d = pos.distanceTo(lk);
    pos.copy(lk).addScaledVector(dir, d * Math.min(1.6, over + 0.02));
  }
  return { pos, look: lk };
}
/** The shooter's or the keeper's end; instant cuts, else the authored 900 ms ease (on fixed steps). */
export function setView(v: "shoot" | "keep", instant = false): void {
  currentView = v === "keep" ? "keep" : "shoot";
  const to = fittedTarget(currentView);
  if (scene.fog instanceof Fog) { // fog follows the fitted distance so a far camera never fogs the goal
    const d = to.pos.distanceTo(new Vector3(0, 0, FRAME.GOAL_Z));
    scene.fog.near = d + 22; scene.fog.far = d + 120;
  }
  if (instant || reducedMotion) {
    camera.position.copy(to.pos);
    camera.lookAt(to.look);
    look0.copy(to.look);
    camAnim = null;
    return;
  }
  camAnim = { t: 0, dur: FRAME.CAM_TRANS_MS / 1000, fromPos: camera.position.clone().sub(shake), fromLook: look0.clone(), toPos: to.pos, toLook: to.look };
}
export function currentCamera(): "shoot" | "keep" { return currentView; }

// ---------------------------------------------------------------- the kick (render.js playKick / updateAnim / skip)
interface Anim {
  t: number; dur: number; ballFrom: Vector3; ballTo: Vector3; curve: string; keeperFrom: Vector3; keeperTo: Vector3; keeperRot: number;
  onDone: (() => void) | null;
}
let anim: Anim | null = null;
export function animating(): boolean { return !!anim; }
/** Plays a resolved kick: the ball flies to its zone (or wide), the keeper dives; onDone at the end. */
export function playKick(ev: KickEvent, onDone: () => void): void {
  if (!ball || !keeper) { onDone(); return; }
  const dur = reducedMotion ? 0.35 : 0.9;
  const target = ev.outcome === "offtarget"
    ? new Vector3((ev.finalCol === "left" ? -1 : ev.finalCol === "right" ? 1 : 0.4) * (FRAME.GOAL_W / 2 + 1.4),
      ev.shot.height === "high" ? FRAME.GOAL_H + 0.9 : 0.5, FRAME.GOAL_Z - 2.2)
    : zoneCenter({ dir: ev.finalCol, height: ev.shot.height });
  const diveX = COLS.indexOf(ev.dive.dir as (typeof COLS)[number]) - 1;
  const diveTarget = new Vector3(diveX * 2.6, ev.dive.height === "high" ? 1.5 : 0.55, FRAME.GOAL_Z + 0.4);
  anim = {
    t: 0, dur, ballFrom: ball.position.clone(), ballTo: target, curve: ev.shot.curve,
    keeperFrom: keeper.position.clone(), keeperTo: diveTarget, keeperRot: diveX * (ev.dive.height === "high" ? 1.1 : 0.7),
    onDone,
  };
  if (!reducedMotion) shakeAmp = ev.outcome === "goal" ? 0.06 : 0.03;
  if (reducedMotion) skip(); // settle instantly
}
function updateAnim(): void {
  if (!anim || !ball || !keeper) return;
  const a = Math.min(1, anim.t / anim.dur);
  const e = a < 0.5 ? 2 * a * a : 1 - Math.pow(-2 * a + 2, 2) / 2;
  ball.position.lerpVectors(anim.ballFrom, anim.ballTo, e);
  ball.position.y += Math.sin(Math.PI * e) * 0.5;
  const bend = anim.curve === "left" ? -1 : anim.curve === "right" ? 1 : 0;
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
/** Settles the exact end state (Skip). */
export function skip(): void {
  if (anim && ball && keeper) {
    ball.position.copy(anim.ballTo);
    keeper.position.copy(anim.keeperTo);
    keeper.rotation.z = anim.keeperRot;
    const done = anim.onDone;
    anim = null;
    if (done) done();
  }
  if (camAnim) {
    camera.position.copy(camAnim.toPos);
    look0.copy(camAnim.toLook);
    camera.lookAt(look0);
    camAnim = null;
  }
  shakeAmp = 0;
}
export function resetPositions(): void {
  anim = null;
  if (ball) { ball.position.copy(ballHome); }
  if (keeper) { keeper.position.copy(keeperHome); keeper.rotation.set(0, 0, 0); }
  showZoneHighlight(null);
}

/** One fixed step (1/60 s): the kick, the camera swing and its shake. */
export function step(dt: number): void {
  if (anim) { anim.t += dt; updateAnim(); }
  camera.position.sub(shake);
  if (camAnim) {
    camAnim.t += dt;
    const a = Math.min(1, camAnim.t / camAnim.dur);
    const e = 1 - Math.pow(1 - a, 3); // easeOutCubic, authored duration
    camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
    look0.copy(camAnim.fromLook).lerp(camAnim.toLook, e);
    camera.lookAt(look0);
    if (a >= 1) camAnim = null;
  }
  if (shakeAmp > 0.001 && !reducedMotion) {
    shake.set((shakeRnd() - 0.5) * shakeAmp, (shakeRnd() - 0.5) * shakeAmp * 0.6, 0);
    shakeAmp *= 0.88;
  } else { shakeAmp = 0; shake.set(0, 0, 0); }
  camera.position.add(shake);
}

// ---------------------------------------------------------------- each frame (render.js updateAmbient / resize)
let ambientT = 0;
let frameKey = "";
/** Each frame: framing into the play rectangle (window px) and the cosmetic ambience. */
export function update(dt: number, w: number, h: number, rect: Rect, scale: number): void {
  const fk = `${w}x${h}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
  if (w > 0 && h > 0 && fk !== frameKey) {
    frameKey = fk;
    win = { w, h };
    view = { ...rect };
    uiScale = scale;
    applyViewOffset();
    const anim0 = camAnim;
    if (anim0) { const to = fittedTarget(currentView); anim0.toPos = to.pos; anim0.toLook = to.look; }
    else setView(currentView, true); // refit for the new aspect
  }
  dt = Math.min(0.25, Math.max(0, dt));
  const moving = !reducedMotion;
  if (moving) ambientT += dt;
  U.uTime.value = ambientT;
  U.uBob.value = moving && look?.crowd === "full" ? 1 : 0;
  if (keeperRig && keeper) {
    const idle = moving && !anim && keeper.rotation.z === 0;
    keeperRig.position.y = idle ? Math.abs(Math.sin(ambientT * 3.1)) * 0.035 : 0;
    keeperRig.position.x = idle ? Math.sin(ambientT * 1.3) * 0.06 : 0;
    (keeperRig.userData.arms as Group[]).forEach((a, i) => { a.rotation.z = (a.userData.base as number) + (idle ? Math.sin(ambientT * 2.4 + i) * 0.08 : 0); });
  }
  if (atmosphere && atmosphere.visible && motes && look) {
    if (moving) {
      const p = motes.geometry.getAttribute("position") as BufferAttribute, arr = p.array as Float32Array, b = moteBase;
      const n = Math.min(arr.length, Math.min(MOTE_MAX, look.budget.motes) * 3);
      for (let i = 0; i < n; i += 3) {
        const ph = i * 0.37;
        arr[i] = b[i]! + Math.sin(ambientT * 0.23 + ph) * 0.9;
        arr[i + 1] = b[i + 1]! + Math.sin(ambientT * 0.31 + ph * 1.7) * 0.5;
        arr[i + 2] = b[i + 2]! + Math.cos(ambientT * 0.19 + ph) * 0.9;
      }
      p.needsUpdate = true;
    }
    halos.forEach((hl, i) => { (hl.material as SpriteMaterial).opacity = 0.7 + (moving ? Math.sin(ambientT * 7 + i * 2.1) * 0.03 : 0); });
  }
  if (ballBlob && ball) {
    const hgt = Math.max(0, ball.position.y - FRAME.BALL_R);
    ballBlob.position.set(ball.position.x, 0.015, ball.position.z);
    const s = 0.62 + hgt * 0.25; ballBlob.scale.set(s, s, 1);
    (ballBlob.material as MeshBasicMaterial).opacity = ((look && look.shadows === 0) ? 0.6 : 0.35) / (1 + hgt);
  }
  if (keeperBlob && keeper) {
    keeperBlob.position.set(keeper.position.x, 0.014, keeper.position.z);
    keeperBlob.visible = keeper.position.y < 0.8;
  }
}
