/* Claude — the Dirty South AI mascot, as a chunky voxel pig.

   Dependency-free ES module: THREE is passed in, nothing else is imported and
   no files are loaded (voxels are generated here; the few decals are painted
   into canvases).

     import { createMascot } from './mascot/mascot.js';
     const m = createMascot(THREE, { smoke: true });
     scene.add(m.root);          // ~1 unit tall, feet on y = 0, facing +z
     m.play('dance');            // 'idle' | 'walk' | 'dance' | 'think' | 'cheer'
     m.play('cheer', { loop: false }); // one shot, then back to idle
     m.update(dt);               // every frame, dt in seconds
     m.dispose();

   Options: smoke (default true) — cigarette smoke puffs; shadows (default true)
   — cast/receive shadows on every part; scale (default 1).

   Identity rules (slides/assets/mascot/NOTES.md): spade + OAI heart on the
   anatomical RIGHT cheek (-x, viewer-left from the front), cigarette at the
   anatomical LEFT mouth corner (+x), cap tipped over the right side, CLAUDE
   banner on the left forehead. Nothing is mirrored. */

export function createMascot(THREE, opts = {}) {
  const { smoke = true, shadows = true, scale = 1 } = opts;
  const U = 0.03; // voxel size (model is authored ~1.1 tall, normalised below)

  const C = {
    skin: 0xf3a28f, skin2: 0xe98e7e, inner: 0xd9737a, snout: 0xe57666, nostril: 0x5e2222,
    cream: 0xf4ead2, black: 0x191515, shirt: 0x1d1c1f, shirt2: 0x2a292d, pants: 0x4a4b52,
    pants2: 0x3b3c42, hoof: 0x3d2620, tongue: 0xd9536a, silver: 0xc9ced6, ember: 0xff5b1f,
    paper: 0xf1e6cf, smoke: 0xbdbdbd, rim: 0x2b1c1c, pupil: 0x121010,
  };

  const disposables = [];
  const own = (x) => { disposables.push(x); return x; };
  const voxMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 }));
  const metal = own(new THREE.MeshStandardMaterial({ color: C.silver, roughness: 0.28, metalness: 0.9 }));

  // ---------- voxel kit ----------
  class Vox {
    constructor() { this.m = new Map(); }
    k(x, y, z) { return ((x + 256) * 512 + (y + 256)) * 512 + (z + 256); }
    set(x, y, z, c) { this.m.set(this.k(x, y, z), [x, y, z, c]); }
    get(x, y, z) { return this.m.get(this.k(x, y, z)); }
    has(x, y, z) { return this.m.has(this.k(x, y, z)); }
    del(x, y, z) { this.m.delete(this.k(x, y, z)); }
    box(x0, x1, y0, y1, z0, z1, c) {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, c);
    }
    paint(x, y, z, c) { const v = this.get(x, y, z); if (v) v[3] = c; }
    front(x, y) { // highest z at (x, y)
      let best = -Infinity;
      for (const [vx, vy, vz] of this.m.values()) if (vx === x && vy === y && vz > best) best = vz;
      return best;
    }
    paintFront(x, y, c) { const z = this.front(x, y); if (z > -Infinity) this.paint(x, y, z, c); return z; }
  }
  const DIRS = [
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
  ];
  const AO = [0.5, 0.68, 0.85, 1];
  const hash = (x, y, z) => {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1103515245);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  // mesh of the exposed faces, with per-vertex AO and a little per-voxel colour noise.
  // `o` is the voxel-space point that lands on the mesh origin.
  function voxMesh(vox, o = [0, 0, 0]) {
    const pos = [], nor = [], col = [], idx = [];
    const c = new THREE.Color();
    for (const [x, y, z, hex] of vox.m.values()) {
      c.set(hex);
      const j = 0.94 + hash(x, y, z) * 0.12;
      for (const d of DIRS) {
        const [nx, ny, nz] = d.n;
        if (vox.has(x + nx, y + ny, z + nz)) continue;
        const base = pos.length / 3, ao = [];
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const ux = d.u[0] * su, uy = d.u[1] * su, uz = d.u[2] * su;
          const vx = d.v[0] * sv, vy = d.v[1] * sv, vz = d.v[2] * sv;
          const s1 = vox.has(x + nx + ux, y + ny + uy, z + nz + uz) ? 1 : 0;
          const s2 = vox.has(x + nx + vx, y + ny + vy, z + nz + vz) ? 1 : 0;
          const cc = vox.has(x + nx + ux + vx, y + ny + uy + vy, z + nz + uz + vz) ? 1 : 0;
          const a = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
          ao.push(a);
          pos.push(
            (x + 0.5 + 0.5 * (nx + ux + vx) - o[0]) * U,
            (y + 0.5 + 0.5 * (ny + uy + vy) - o[1]) * U,
            (z + 0.5 + 0.5 * (nz + uz + vz) - o[2]) * U,
          );
          nor.push(nx, ny, nz);
          const f = AO[a] * j;
          col.push(c.r * f, c.g * f, c.b * f);
        }
        if (ao[0] + ao[2] < ao[1] + ao[3]) idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
        else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    const g = own(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, voxMat);
    m.castShadow = shadows; m.receiveShadow = shadows;
    return m;
  }

  const group = (parent, x = 0, y = 0, z = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };
  const ringGeo = own(new THREE.TorusGeometry(0.03, 0.009, 4, 8));
  const ring = (parent, x, y, z, ry = 0, rx = 0, s = 1) => {
    const m = new THREE.Mesh(ringGeo, metal);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    m.scale.setScalar(s);
    m.castShadow = shadows;
    parent.add(m);
    return m;
  };

  // ---------- decals (tiny pixel canvases) ----------
  const decal = (w, h, draw) => {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    draw(cv.getContext('2d'));
    const t = own(new THREE.CanvasTexture(cv));
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const px = (g, color, cells) => { g.fillStyle = color; for (const [x, y, w = 1, h = 1] of cells) g.fillRect(x, y, w, h); };
  const plane = (parent, tex, w, h, x, y, z, rx = 0, ry = 0) => {
    const m = new THREE.Mesh(own(new THREE.PlaneGeometry(w, h)), own(new THREE.MeshStandardMaterial({
      map: tex, transparent: true, alphaTest: 0.5, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4,
    })));
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    m.receiveShadow = shadows;
    parent.add(m);
    return m;
  };
  const GLYPH = {
    C: ['111', '100', '100', '100', '111'], L: ['100', '100', '100', '100', '111'],
    A: ['010', '101', '111', '101', '101'], U: ['101', '101', '101', '101', '111'],
    D: ['110', '101', '101', '101', '110'], E: ['111', '100', '110', '100', '111'],
    S: ['111', '100', '111', '001', '111'], M: ['101', '111', '111', '101', '101'],
    O: ['111', '101', '101', '101', '111'], K: ['101', '110', '100', '110', '101'],
    I: ['111', '010', '010', '010', '111'], F: ['111', '100', '110', '100', '100'],
    Y: ['101', '101', '010', '010', '010'], G: ['111', '100', '101', '101', '111'],
    T: ['111', '010', '010', '010', '010'], "'": ['1', '1', '0', '0', '0'], ' ': ['0', '0', '0', '0', '0'],
  };
  const text = (g, str, x, y, color) => {
    for (const ch of str) {
      const gl = GLYPH[ch] || GLYPH[' '];
      gl.forEach((row, yy) => [...row].forEach((b, xx) => { if (b === '1') px(g, color, [[x + xx, y + yy]]); }));
      x += gl[0].length + 1;
    }
  };
  const bannerTex = decal(44, 16, (g) => {
    const K = '#191515';
    for (const sx of [14, 21, 28]) px(g, K, [[sx, 0], [sx - 1, 1, 3, 1], [sx, 2]]);
    px(g, K, [[3, 5, 38, 9]]);
    px(g, '#f6dccd', [[4, 6, 36, 7]]);
    px(g, K, [[0, 7, 3, 1], [0, 12, 3, 1], [1, 8, 1, 4], [41, 7, 3, 1], [41, 12, 3, 1], [42, 8, 1, 4]]);
    text(g, 'CLAUDE', 7, 7, K);
  });
  const cheekTex = decal(16, 24, (g) => {
    const K = '#231818';
    px(g, K, [[7, 0, 2, 1], [6, 1, 4, 1], [5, 2, 6, 1], [4, 3, 8, 3], [5, 6, 2, 1], [9, 6, 2, 1], [7, 6, 2, 2], [6, 8, 4, 1]]);
    px(g, K, [[2, 11, 4, 2], [10, 11, 4, 2], [1, 12, 2, 4], [13, 12, 2, 4], [6, 12, 4, 2], [2, 16, 2, 2], [12, 16, 2, 2],
      [4, 18, 2, 2], [10, 18, 2, 2], [6, 20, 4, 2]]);
    px(g, '#f3a28f', [[3, 13, 10, 3], [4, 16, 8, 2], [6, 18, 4, 2]]);
    px(g, K, [[4, 14, 2, 1], [8, 14, 1, 2], [10, 14, 1, 2], [5, 16, 1, 1]]);
  });
  const skullTex = decal(16, 16, (g) => {
    const K = '#191515';
    px(g, K, [[5, 1, 6, 1], [4, 2, 8, 5], [5, 7, 6, 1], [6, 8, 1, 1], [9, 8, 1, 1]]);
    px(g, '#f4ead2', [[5, 4, 2, 2], [9, 4, 2, 2], [7, 6, 2, 1]]);
    px(g, K, [[2, 10, 2, 1], [12, 10, 2, 1], [4, 11, 2, 1], [10, 11, 2, 1], [6, 12, 4, 1], [4, 13, 2, 1],
      [10, 13, 2, 1], [2, 14, 2, 1], [12, 14, 2, 1], [1, 9, 1, 2], [14, 9, 1, 2], [1, 14, 1, 2], [14, 14, 1, 2]]);
  });
  const sloganTex = decal(40, 20, (g) => {
    const K = '#191515';
    text(g, "SMOKE 'EM", 1, 1, K);
    text(g, 'IF YOU', 8, 7, K);
    text(g, "GOT 'EM", 5, 13, K);
  });

  // ---------- rig ----------
  const root = new THREE.Group();
  root.name = 'mascot';
  const rig = group(root);
  rig.scale.setScalar(scale / 1.1);

  const HIP = 7 * U;
  const hips = group(rig, 0, HIP, 0);
  const torso = group(hips);

  { // shorts + sleeveless shirt
    const v = new Vox();
    v.box(-6, 5, -3, -1, -4, 3, C.pants);
    for (let x = -6; x <= 5; x++) v.paint(x, -1, 3, C.pants2);
    v.box(-6, 5, 0, 7, -4, 3, C.shirt);
    for (const x of [-6, 5]) for (const z of [-4, 3]) for (let y = 0; y <= 7; y++) v.del(x, y, z);
    for (let z = -4; z <= 3; z++) { v.del(-6, 7, z); v.del(5, 7, z); }
    v.box(-2, 1, 7, 7, 1, 3, C.skin); v.box(-1, 0, 6, 6, 3, 3, C.skin); // neckline
    for (let x = -5; x <= 4; x++) v.paint(x, 0, 3, C.shirt2); // hem
    torso.add(voxMesh(v));
  }
  // curly tail, pivot on the seat of the shorts
  const tail = group(torso, 0, -1.5 * U, -4 * U);
  {
    const v = new Vox();
    v.set(0, 0, -1, C.skin);
    for (const [x, y] of [[-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0]].slice(0, 7)) v.set(x, y, -2, C.skin);
    v.set(0, 2, -2, C.skin2);
    tail.add(voxMesh(v, [0.5, 0.5, 0]));
  }
  // legs: pivot at the hip joint
  const leg = (side) => {
    const g = group(torso, side * 3 * U, -3 * U, 0);
    const v = new Vox();
    v.box(-2, 1, -2, -1, -2, 1, C.skin);
    v.box(-2, 1, -4, -3, -2, 2, C.hoof);
    v.paint(-1, -3, 2, C.black); v.paint(-1, -4, 2, C.black);
    g.add(voxMesh(v));
    return { g };
  };
  const legL = leg(1), legR = leg(-1);
  // arms: pivot at the shoulder
  const arm = (side) => {
    const g = group(torso, side * 6 * U, 6.5 * U, 0);
    const v = new Vox();
    const x0 = side > 0 ? 0 : -3;
    v.box(x0, x0 + 2, -6, -1, -1, 1, C.skin);
    v.box(x0, x0 + 2, -5, -4, -1, 1, C.skin2);
    const hand = group(g, 0, -6 * U, 0);
    const h = new Vox();
    h.box(x0, x0 + 2, -2, -1, -1, 1, C.hoof);
    h.paint(x0 + 1, -2, 1, C.black);
    g.add(voxMesh(v, [0, 0, 0.5]));
    hand.add(voxMesh(h, [0, -6, 0.5]));
    hand.children[0].position.y = 0;
    return { g, hand };
  };
  const armL = arm(1), armR = arm(-1);

  // ---------- head ----------
  const neck = group(torso, 0, 8 * U, 0);
  const head = group(neck);
  const hv = new Vox();
  { // rounded skull: a superellipsoid 22 x 18 x 16 voxels
    const P = 2.6;
    for (let x = -11; x <= 10; x++) for (let y = 0; y <= 17; y++) for (let z = -8; z <= 7; z++) {
      const dx = Math.abs((x + 0.5) / 11), dy = Math.abs((y + 0.5 - 9) / 9), dz = Math.abs((z + 0.5) / 8);
      if (dx ** P + dy ** P + dz ** P <= 1) hv.set(x, y, z, (y < 4 && hash(x, y, z) > 0.5) ? C.skin2 : C.skin);
    }
  }
  // eyes: big cream ovals on a flat plate standing proud of the face, thin
  // dark rim, one solid black pupil (reads cleanly even when small)
  const eyeVox = [];
  for (const side of [-1, 1]) {
    const cx = side * 4.7, cy = 10.2, rx = 3.5, ry = 4.5;
    const pcx = cx - side * 0.35, pcy = cy - 0.9;
    const cells = [];
    for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx); x++) for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry); y++) {
      const e = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
      if (e <= 1 && hv.front(x, y) > -Infinity) cells.push([x, y, e]);
    }
    const plate = Math.max(...cells.map(([x, y]) => hv.front(x, y))) + 1;
    for (const [x, y, e] of cells) {
      const p = ((x + 0.5 - pcx) / 1.45) ** 2 + ((y + 0.5 - pcy) / 2.2) ** 2;
      const col = e > 0.74 ? C.rim : p <= 1 ? C.pupil : C.cream;
      for (let z = hv.front(x, y) + 1; z < plate; z++) hv.set(x, y, z, C.rim);
      hv.set(x, y, plate, col);
      eyeVox.push([x, y, plate, side]);
    }
  }
  // one brow, over the anatomical left eye (the cap covers the other)
  for (const [x, y] of [[2, 15], [3, 16], [4, 16], [5, 16], [6, 16], [7, 15]]) hv.set(x, y, hv.front(x, y) + 1, C.rim);
  // snout: 7 x 5, protruding, a touch to the anatomical left like the logo
  {
    const zf = hv.front(1, 4);
    for (let x = -2; x <= 4; x++) for (let y = 2; y <= 6; y++) for (let z = zf - 2; z <= zf + 3; z++) {
      const corner = (x === -2 || x === 4) && (y === 2 || y === 6);
      if (corner && z === zf + 3) continue;
      hv.set(x, y, z, (z === zf + 3 && (y === 2 || x === -2 || x === 4)) || (z < zf + 3 && y === 2) ? C.skin2 : C.snout);
    }
    for (const x of [-1, 0, 2, 3]) for (const y of [4, 5]) { hv.del(x, y, zf + 3); hv.set(x, y, zf + 2, C.nostril); }
    head.userData.snoutZ = (zf + 4) * U;
  }
  // mouth, tongue
  for (const x of [-1, 0, 1, 2, 3, 4, 5]) hv.paintFront(x, 1, C.black);
  hv.paintFront(6, 2, C.black);
  for (const x of [0, 1]) hv.set(x, 0, hv.front(x, 1), C.tongue);
  const headMesh = voxMesh(hv);
  head.add(headMesh);
  // spade + OAI heart on the anatomical right cheek (-x), as crisp decals
  plane(head, cheekTex, 0.13, 0.2, -8.6 * U, 5.2 * U, (hv.front(-9, 5) + 1.08) * U, 0, -0.5);
  const eyeZ = Math.max(...eyeVox.map((e) => e[2]));

  // nose rings, ear-less hoops, eyebrow ring, chin stud
  const sz = head.userData.snoutZ;
  ring(head, -0.5 * U, 3.7 * U, sz - 0.3 * U, 0, 0.5, 0.75);
  ring(head, 3.5 * U, 3.7 * U, sz - 0.3 * U, 0, 0.5, 0.75);
  ring(head, 7.8 * U, 15.6 * U, (hv.front(7, 15) + 1) * U, 0.4, 0, 0.8);
  { const s = new THREE.Mesh(own(new THREE.BoxGeometry(U, U, U)), metal); s.position.set(1.5 * U, -0.2 * U, (hv.front(1, 0) + 0.6) * U); head.add(s); }

  // cigarette at the anatomical-left mouth corner (+x)
  const cig = group(head, 6 * U, 1.6 * U, (hv.front(6, 2) + 0.6) * U);
  cig.rotation.set(0.12, -0.55, -0.18);
  {
    const v = new Vox();
    v.box(0, 6, 0, 0, 0, 0, C.paper);
    cig.add(voxMesh(v, [0, 0.5, 0.5]));
  }
  const ember = new THREE.Mesh(own(new THREE.BoxGeometry(U * 1.05, U * 1.05, U * 1.05)),
    own(new THREE.MeshStandardMaterial({ color: C.ember, emissive: C.ember, emissiveIntensity: 2.5 })));
  ember.position.set(7.5 * U, 0, 0);
  cig.add(ember);
  const emberTip = group(cig, 8 * U, 0.6 * U, 0);

  // CLAUDE banner + stars, left forehead (+x)
  plane(head, bannerTex, 0.2, 0.073, 5 * U, 14.3 * U, (hv.front(4, 14) + 1.02) * U, -0.12, 0.12);

  // ears: pointy, black-rimmed, with hoops
  const ear = (side) => {
    const g = group(head, side * 8 * U, 15 * U, -1 * U);
    g.rotation.set(-0.15, 0, side * -0.45);
    const v = new Vox();
    const rows = [[-3, 2], [-3, 2], [-2, 2], [-2, 1], [-1, 1], [-1, 0], [0, 0]];
    rows.forEach(([a, b], y) => {
      for (let x = a; x <= b; x++) for (let z = -1; z <= 0; z++) {
        const rim = x === a || x === b || y === rows.length - 1;
        v.set(side > 0 ? x : -x - 1, y, z, rim ? C.black : z === 0 && y > 0 && y < 5 ? C.inner : C.skin);
      }
    });
    g.add(voxMesh(v, [0, 0, 0]));
    ring(g, side * 3 * U, 1.5 * U, -0.5 * U, Math.PI / 2);
    ring(g, side * 2.5 * U, 3.5 * U, -0.5 * U, Math.PI / 2);
    return g;
  };
  const earL = ear(1), earR = ear(-1);
  ring(head, -11.2 * U, 7 * U, 0.5 * U, Math.PI / 2);
  ring(head, 11.2 * U, 6 * U, 0, Math.PI / 2);

  // folded sailor cap, tipped over the anatomical right (-x)
  const hat = group(head, -3.5 * U, 15.8 * U, 0.5 * U);
  hat.rotation.set(-0.08, 0.18, 0.26);
  {
    const v = new Vox();
    const hd = (y) => Math.max(1, Math.round(4.5 - y * 0.6));
    for (let x = -7; x <= 6; x++) {
      const xc = Math.abs(x + 0.5);
      const top = Math.round(7.2 - xc * 0.55); // peaked like a folded paper cap
      for (let y = 0; y <= top; y++) {
        const d = hd(y);
        for (let z = -d; z < d; z++) {
          const edge = y === 0 || y === top || xc > 6;
          v.set(x, y, z, edge ? C.black : C.cream);
        }
      }
    }
    // the fold line across the front
    for (let y = 1; y <= 5; y++) { const x = -2 + Math.round(y * 0.55); const z = v.front(x, y); if (z > -Infinity) v.paint(x, y, z, C.black); }
    hat.add(voxMesh(v));
    plane(hat, skullTex, 0.1, 0.1, 2.8 * U, 2.6 * U, 3.2 * U, -0.54);
    plane(hat, sloganTex, 0.13, 0.065, -3.8 * U, 2.2 * U, 3.45 * U, -0.54);
  }

  // ---------- smoke ----------
  const puffs = [];
  if (smoke) {
    const pg = own(new THREE.BoxGeometry(U * 1.2, U * 1.2, U * 1.2));
    for (let n = 0; n < 7; n++) {
      const pm = own(new THREE.MeshStandardMaterial({ color: C.smoke, transparent: true, opacity: 0, roughness: 1, depthWrite: false }));
      const p = new THREE.Mesh(pg, pm);
      p.visible = false;
      root.add(p);
      puffs.push({ m: p, age: n * 0.37, life: 2.6, vx: 0, vz: 0 });
    }
  }
  const tmp = new THREE.Vector3();

  // ---------- animation ----------
  // Each clip is pose(t) -> flat object of numbers. Switching clips cross-fades
  // from a snapshot of the last pose.
  const ZERO = {
    hipY: 0, hipX: 0, hipZ: 0, spinY: 0, leanX: 0, leanZ: 0, torsoY: 0,
    headX: 0, headY: 0, headZ: 0,
    armLx: 0, armLz: 0, armRx: 0, armRz: 0, handL: 0, handR: 0,
    legLx: 0, legRx: 0, legLz: 0, legRz: 0, tail: 0, ears: 0, squash: 1,
  };
  const TAU = Math.PI * 2;
  const s = Math.sin, c = Math.cos, abs = Math.abs;

  const clips = {
    idle: {
      period: 3.2,
      pose(t) {
        const b = s(t * TAU / 3.2);
        return { ...ZERO, hipY: b * 0.004, squash: 1 + b * 0.015, headX: -0.02 + b * 0.025, headZ: s(t * 0.7) * 0.04,
          armLz: 0.1 + b * 0.03, armRz: -0.1 - b * 0.03, tail: s(t * 5) * 0.35, ears: s(t * 1.3) * 0.05 };
      },
    },
    walk: {
      period: 0.5,
      pose(t) {
        const p = t * TAU / 0.5, w = s(p);
        return { ...ZERO, hipY: abs(c(p)) * 0.03 - 0.008, leanX: 0.07, hipZ: w * 0.04, torsoY: w * 0.1,
          headX: -0.03 + abs(s(p)) * 0.04, headZ: -w * 0.05,
          legLx: w * 0.8, legRx: -w * 0.8, armLx: -w * 0.85, armRx: w * 0.85, armLz: 0.1, armRz: -0.1,
          tail: s(p * 2) * 0.5, ears: abs(w) * 0.12 };
      },
    },
    dance: {
      period: 4.0, // ~120 bpm; alternates two moves every 2s
      pose(t) {
        const beat = t * TAU * 2;
        const move = Math.floor(t / 2) % 2;
        const bounce = abs(s(beat / 2));
        const sway = s(beat / 2);
        if (move === 0) { // hands up, twisting
          return { ...ZERO, hipY: bounce * 0.05, squash: 1 - (1 - bounce) * 0.06, hipZ: sway * 0.12, spinY: s(t * TAU / 2) * 0.55,
            headZ: -sway * 0.18, headX: -0.06 + bounce * 0.08,
            armLz: 2.0 + s(beat) * 0.35, armRz: -2.0 + s(beat) * 0.35,
            legLx: -bounce * 0.3, legRx: -(1 - bounce) * 0.3, legLz: 0.08, legRz: -0.08, tail: s(beat * 2) * 0.8, ears: bounce * 0.3 };
        }
        return { ...ZERO, hipY: bounce * 0.06, squash: 1 - (1 - bounce) * 0.07, hipZ: sway * 0.15, spinY: sway * 0.3, // arm pumps
          headZ: -sway * 0.2, headX: -0.08 + bounce * 0.1,
          armLz: 0.6 + bounce * 0.9, armRz: -0.6 - (1 - bounce) * 0.9, armLx: -0.9 * bounce, armRx: -0.9 * (1 - bounce),
          legLx: -bounce * 0.45, legRx: -(1 - bounce) * 0.45, tail: s(beat * 2) * 0.8, ears: bounce * 0.3 };
      },
    },
    think: {
      period: 4,
      pose(t) {
        const b = s(t * TAU / 4);
        return { ...ZERO, hipY: b * 0.004, headZ: 0.2 + b * 0.05, headX: -0.14, headY: 0.18, leanZ: -0.03,
          armRx: -2.0, armRz: -0.5, handR: 0.5,       // hoof to chin
          armLx: -0.4, armLz: 0.95,                    // hoof on hip
          legLz: 0.04, legRz: -0.04, legLx: abs(s(t * TAU * 1.2)) * -0.12, tail: s(t * 2) * 0.2 };
      },
    },
    cheer: {
      period: 0.9,
      pose(t) {
        const p = (t % 0.9) / 0.9;
        const jump = p < 0.7 ? s(p / 0.7 * Math.PI) : 0;
        const crouch = p < 0.12 ? s(p / 0.12 * Math.PI) * 0.6 : p > 0.7 ? s((p - 0.7) / 0.3 * Math.PI) * 0.8 : 0;
        return { ...ZERO, hipY: jump * 0.26 - crouch * 0.035, squash: 1 - crouch * 0.12 + jump * 0.05,
          armLz: 2.05 - crouch * 0.6, armRz: -2.05 + crouch * 0.6, armLx: -0.25, armRx: -0.25,
          legLx: -jump * 0.5, legRx: -jump * 0.5, legLz: jump * 0.15, legRz: -jump * 0.15,
          headX: -0.2 * jump, tail: s(t * 30) * 0.6, ears: jump * 0.5 };
      },
    },
  };
  const names = Object.keys(clips);

  let cur = 'idle', t = 0, loop = true;
  let from = { ...ZERO }, fade = 1, fadeDur = 0.2;
  let pose = clips.idle.pose(0);
  let blinkIn = 2 + Math.random() * 3, blinkT = 0, clock = 0;

  function play(name, { loop: lp = true, fade: f = 0.2 } = {}) {
    if (!clips[name]) return;
    if (name === cur && lp === loop) return;
    from = { ...pose };
    cur = name; t = 0; loop = lp; fade = 0; fadeDur = f;
  }

  function apply(p) {
    hips.position.y = HIP + p.hipY;
    hips.rotation.set(p.leanX, 0, p.hipZ);
    rig.rotation.y = p.spinY;
    torso.rotation.set(0, p.torsoY, p.leanZ);
    const sq = 1 + (1 - p.squash) * 0.5;
    torso.scale.set(sq, p.squash, sq);
    head.rotation.set(p.headX, p.headY, p.headZ);
    armL.g.rotation.set(p.armLx, 0, p.armLz);
    armR.g.rotation.set(p.armRx, 0, p.armRz);
    armL.hand.rotation.x = p.handL;
    armR.hand.rotation.x = p.handR;
    legL.g.rotation.set(p.legLx, 0, p.legLz);
    legR.g.rotation.set(p.legRx, 0, p.legRz);
    tail.rotation.set(0, 0, p.tail);
    earL.rotation.z = -0.45 - p.ears;
    earR.rotation.z = 0.45 + p.ears;
  }

  // blink: squash the eye voxels by hiding them for a frame or two
  const eyeGeo = headMesh.geometry;
  function update(dt) {
    dt = Math.min(dt, 0.1);
    t += dt; clock += dt;
    if (!loop && t >= clips[cur].period) play('idle');
    const target = clips[cur].pose(t);
    if (fade < 1) {
      fade = Math.min(1, fade + dt / Math.max(0.001, fadeDur));
      const k = fade * fade * (3 - 2 * fade);
      for (const key in target) target[key] = from[key] + (target[key] - from[key]) * k;
    }
    pose = target;
    apply(pose);

    blinkIn -= dt;
    if (blinkIn <= 0) { blinkT = 0.13; blinkIn = 2.5 + Math.random() * 4; }
    if (blinkT > 0) blinkT -= dt;
    lids.visible = blinkT > 0;

    ember.material.emissiveIntensity = 2.1 + Math.sin(clock * 13) * 0.6 + Math.random() * 0.4;

    if (smoke) {
      root.updateMatrixWorld(true);
      for (const p of puffs) {
        p.age += dt;
        if (p.age >= p.life) {
          p.age -= p.life;
          emberTip.getWorldPosition(tmp);
          root.worldToLocal(tmp);
          p.m.position.copy(tmp);
          p.vx = (Math.random() - 0.5) * 0.05;
          p.vz = (Math.random() - 0.5) * 0.05;
          p.m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
        }
        const k = p.age / p.life;
        p.m.visible = true;
        p.m.position.x += (p.vx + Math.sin(p.age * 3 + p.life) * 0.03) * dt;
        p.m.position.z += p.vz * dt;
        p.m.position.y += 0.15 * dt;
        p.m.scale.setScalar(0.5 + k * 1.8);
        p.m.material.opacity = 0.5 * (1 - k) * Math.min(1, p.age * 5);
        p.m.rotation.y += dt;
      }
    }
  }

  // eyelids: a skin-coloured shell over the eye voxels, shown while blinking
  const lids = (() => {
    const v = new Vox();
    for (const [x, y, z] of eyeVox) v.set(x, y, z + 1, C.skin2);
    const m = voxMesh(v);
    m.visible = false;
    head.add(m);
    return m;
  })();
  void eyeGeo; void eyeZ;

  function dispose() {
    root.removeFromParent();
    for (const d of disposables) d.dispose?.();
  }

  apply(pose);
  return { root, names, play, update, dispose, get current() { return cur; } };
}
