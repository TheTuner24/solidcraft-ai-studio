// SolidCraft AI Studio – Tablet-Oberfläche.
// Koordinaten: Die Szene arbeitet in SolidCraft-Weltkoordinaten (mm, Z oben).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = (s) => document.querySelector(s);
const viewport = $('#viewport');
const overlay = $('#overlay');
// CPU-Leinwand: Mit GPU-Beschleunigung tauchte in Chrome gelegentlich ein schon gelöschter Strich wieder auf.
const octx = overlay.getContext('2d', { willReadFrequently: true });

// ---------- 3D-Ansicht ----------
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x2a2f38);
viewport.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
camera.up.set(0, 0, 1);
camera.position.set(150, -150, 120);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
scene.add(sun);
const grid = new THREE.GridHelper(400, 40, 0x56606f, 0x3a414c);
grid.rotation.x = Math.PI / 2;            // Gitter in der XY-Ebene
scene.add(grid);
const axes = new THREE.AxesHelper(30);
scene.add(axes);
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

let modelRoot = null;
// SolidCraft-Skizzen als Linien (der GLB-Export enthält nur Körper). Hilfslinien gestrichelt.
const sketchRoot = new THREE.Group();
scene.add(sketchRoot);
const SKETCH_MAT = new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true, opacity: 0.95 });
const SKETCH_CONSTR_MAT = new THREE.LineDashedMaterial({ color: 0x9aa6b8, dashSize: 2, gapSize: 1.5, depthTest: false, transparent: true, opacity: 0.7 });
function renderSketches(list) {
  for (const o of [...sketchRoot.children]) { sketchRoot.remove(o); o.geometry.dispose(); }
  for (const sk of list || []) for (const l of sk.lines) {
    const g = new THREE.BufferGeometry().setFromPoints(l.pts.map((p) => new THREE.Vector3(...p)));
    const line = new THREE.Line(g, l.construction ? SKETCH_CONSTR_MAT : SKETCH_MAT);
    if (l.construction) line.computeLineDistances();
    line.renderOrder = 2; line.name = sk.name;
    sketchRoot.add(line);
  }
}
let firstModel = true;
const loader = new GLTFLoader();

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const dpr = Math.min(window.devicePixelRatio, 2);
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawStrokes();
}
new ResizeObserver(resize).observe(viewport);

let lastCamKey = '';
function animate() {
  controls.update();
  sun.position.copy(camera.position).add(new THREE.Vector3(50, -30, 120));
  renderer.render(scene, camera);
  const key = camera.position.toArray().map((v) => v.toFixed(2)).join() + controls.target.toArray().join();
  if (key !== lastCamKey) { lastCamKey = key; drawStrokes(); }
  requestAnimationFrame(animate);
}

function modelBox() {
  const box = new THREE.Box3();
  if (modelRoot) box.setFromObject(modelRoot);
  if (sketchRoot.children.length) box.expandByObject(sketchRoot);
  return box;
}

function fitView(dir) {
  const box = modelBox();
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  if (box.isEmpty()) { box.set(new THREE.Vector3(-60, -60, 0), new THREE.Vector3(60, 60, 10)); }
  box.getSize(size); box.getCenter(center);
  const radius = Math.max(size.length() / 2, 10);
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
  const d = (dir || camera.position.clone().sub(controls.target)).normalize();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(d, dist);
  camera.near = dist / 100; camera.far = dist * 100;
  camera.updateProjectionMatrix();
  grid.position.set(Math.round(center.x / 10) * 10, Math.round(center.y / 10) * 10, 0);
}
const VIEW_TOP = new THREE.Vector3(0, -0.0001, 1);
const VIEW_ISO = new THREE.Vector3(1, -1, 0.8);

let wantedRev = 0;
function loadModel(rev, empty) {
  wantedRev = rev;
  if (empty) { setModel(null); return; }
  loader.load(`/model.glb?rev=${rev}`, (gltf) => {
    // Bei schnellen Änderungen kann ein älterer Download später fertig werden: verwerfen.
    if (rev !== wantedRev) return;
    const root = gltf.scene;
    // SolidCraft exportiert in Metern mit Y oben (Wurzelknoten gedreht und skaliert):
    // die Wurzeltransformation zurücksetzen ergibt wieder mm mit Z oben.
    for (const child of root.children) { child.quaternion.identity(); child.scale.set(1, 1, 1); child.position.set(0, 0, 0); }
    root.traverse((o) => {
      if (o.isMesh) {
        o.material.side = THREE.DoubleSide;
        o.material.polygonOffset = true; o.material.polygonOffsetFactor = 1; o.material.polygonOffsetUnits = 1;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 25),
          new THREE.LineBasicMaterial({ color: 0x111418 }));
        edges.userData.isEdge = true;
        o.add(edges);
      }
    });
    setModel(root);
  }, undefined, (err) => toast('Modell konnte nicht geladen werden: ' + err.message));
}

function setModel(root) {
  if (modelRoot) {
    scene.remove(modelRoot);
    modelRoot.traverse((o) => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); });
  }
  modelRoot = root;
  if (root) scene.add(root);
  if (firstModel && (root || sketchRoot.children.length)) { firstModel = false; fitView(VIEW_ISO.clone()); }
  if (pendingSketch) { const m = pendingSketch; pendingSketch = null; applyLastSketch(m); }
  reanchorStrokes();
}

// Kamera im Format von SolidCraft (ui.camera / view.apply): yaw 0 = Blick entlang +Y.
function scCamera() {
  const dir = controls.target.clone().sub(camera.position);
  const distance = dir.length();
  dir.normalize();
  return {
    target: controls.target.toArray().map((v) => +v.toFixed(3)),
    yaw: +Math.atan2(dir.x, dir.y).toFixed(5),
    pitch: +Math.asin(-dir.z).toFixed(5),
    distance: +distance.toFixed(2),
    fov_deg: camera.fov,
  };
}

// ---------- Stiftstriche ----------
// Jeder Punkt eines Strichs bekommt einen 3D-Anker (Treffer am Modell, sonst Bodenebene Z=0,
// sonst Ebene durch das Blickziel), so bleiben Striche beim Drehen am Modell kleben.
let tool = 'pen';
// Strichfarben: nur Unterscheidung, keine feste Bedeutung. Was eine Farbe meint, sagt der Benutzer.
const COLORS = [
  { name: 'rot', hex: '#ff3b3b' }, { name: 'blau', hex: '#2f8cff' }, { name: 'grün', hex: '#2ecc55' },
  { name: 'orange', hex: '#ff9a1f' }, { name: 'violett', hex: '#b45cff' }, { name: 'türkis', hex: '#19d3c5' },
];
let color = COLORS[0];
let legend = {};
let strokes = [];
let current = null;
let lastPen = 0;
const raycaster = new THREE.Raycaster();

function ndc(x, y) {
  return new THREE.Vector2((x / viewport.clientWidth) * 2 - 1, -(y / viewport.clientHeight) * 2 + 1);
}

function pick(x, y) {
  raycaster.setFromCamera(ndc(x, y), camera);
  if (modelRoot) {
    const meshes = [];
    modelRoot.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (hit) {
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
      if (n && n.dot(raycaster.ray.direction) > 0) n.negate();
      let body = hit.object.name;
      for (let o = hit.object; o && o !== modelRoot; o = o.parent) if (o.name) { body = o.name; break; }
      return { p: hit.point.clone(), n, body, on: 'modell' };
    }
  }
  const g = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, g) && g.distanceTo(camera.position) < camera.far) {
    return { p: g, n: new THREE.Vector3(0, 0, 1), body: null, on: 'boden' };
  }
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    camera.getWorldDirection(new THREE.Vector3()), controls.target);
  const v = new THREE.Vector3();
  raycaster.ray.intersectPlane(plane, v);
  return { p: v, n: null, body: null, on: 'ansicht' };
}

function project(p) {
  const v = p.clone().project(camera);
  return [(v.x + 1) / 2 * viewport.clientWidth, (1 - v.y) / 2 * viewport.clientHeight, v.z];
}

function reanchorStrokes() {
  // Die 3D-Anker bleiben gültig, solange sich die markierte Stelle nicht ändert.
  drawStrokes();
}

const drawLog = [];   // Diagnose: letzte Zeichenvorgänge (studioDebug.drawLog)
function clearOverlay(hard) {
  // Unabhängig von der aktuellen Transformation löschen; bei leerer Ebene die Fläche ganz zurücksetzen
  // (im Volltest blieben sonst gelegentlich Pixel eines alten Strichs stehen, obwohl gelöscht wurde).
  if (hard) {
    overlay.width = overlay.width;
    const dpr = Math.min(window.devicePixelRatio, 2);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return;
  }
  octx.save();
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.globalAlpha = 1;
  octx.globalCompositeOperation = 'source-over';
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.restore();
}
function drawStrokes(why = '') {
  const list = [...strokes, current].filter((s) => s && !s.erase);
  clearOverlay(list.length === 0);
  drawLog.push({ t: Math.round(performance.now()), why, n: strokes.length, cur: !!current, drawn: list.length });
  if (drawLog.length > 40) drawLog.shift();
  for (const s of list) {
    const pts = s.anchors && s.cam !== lastCamKeyAtDraw() ? s.anchors.map((a) => project(a.p)) : s.pts;
    if (pts.length < 1) continue;
    const hex = (s.color || COLORS[0]).hex;
    octx.strokeStyle = hex;
    octx.globalAlpha = s === current ? 0.8 : 1;
    octx.lineCap = 'round'; octx.lineJoin = 'round';
    for (let i = 1; i < pts.length; i++) {
      octx.lineWidth = widthFor(s.pr[i] ?? 0.5);
      octx.beginPath(); octx.moveTo(pts[i - 1][0], pts[i - 1][1]); octx.lineTo(pts[i][0], pts[i][1]); octx.stroke();
    }
    if (pts.length === 1) { octx.fillStyle = hex; octx.beginPath(); octx.arc(pts[0][0], pts[0][1], 3, 0, 7); octx.fill(); }
  }
  octx.globalAlpha = 1;
  updateMarkInfo();
}
function lastCamKeyAtDraw() { return lastCamKey; }
// Druck 0…1 → Strichbreite in px: leicht 1 px, fest 7 px (Wurzel, damit leichte Striche sichtbar bleiben).
const widthFor = (pr) => 1 + 6 * Math.sqrt(Math.min(1, Math.max(0, pr)));

function finishStroke(s) {
  if (s.pts.length < 2) s.pts.push([s.pts[0][0] + 0.5, s.pts[0][1] + 0.5]);
  s.anchors = s.pts.map(([x, y]) => pick(x, y));
  s.cam = lastCamKey;
  const [x0, y0] = s.pts[0], [x1, y1] = s.pts[s.pts.length - 1];
  const len = s.pts.reduce((acc, p, i) => i ? acc + Math.hypot(p[0] - s.pts[i - 1][0], p[1] - s.pts[i - 1][1]) : 0, 0);
  s.closed = len > 60 && Math.hypot(x1 - x0, y1 - y0) < Math.max(30, len * 0.15);
  s.inside = s.closed ? interiorHits(s.pts) : [];
  strokes.push(s);
}

function interiorHits(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const out = [];
  const steps = 7;
  for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
    const x = minX + (maxX - minX) * i / steps, y = minY + (maxY - minY) * j / steps;
    if (pointInPoly(x, y, pts)) out.push(pick(x, y));
  }
  return out;
}
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function eraseAt(x, y) {
  const before = strokes.length;
  strokes = strokes.filter((s) => {
    const pts = s.anchors ? s.anchors.map((a) => project(a.p)) : s.pts;
    return !pts.some((p) => Math.hypot(p[0] - x, p[1] - y) < 18);
  });
  if (strokes.length !== before) drawStrokes();
}

function local(e) {
  const r = viewport.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
// ---------- Eingabe: Stift zeichnet, Finger navigiert ----------
// Stift (pointerType "pen") und linke Maustaste zeichnen, Finger ("touch") drehen und zoomen über
// OrbitControls. Handballen-Erkennung:
//  1. Solange der Stift zeichnet, schwebt (Hover) oder vor < PALM_MS aktiv war, zählt keine Berührung.
//  2. Berührungen mit großer Kontaktfläche (width/height ≥ PALM_SIZE px) sind ein Handballen.
//  3. Eine ignorierte Berührung bleibt bis zum Loslassen ignoriert.
//  4. Setzt der Stift auf, während schon Finger liegen, ist die Navigation bis zum Strichende gesperrt.
// Radieren: Werkzeug „Radierer“, Radiererende des Stifts (button 5 / buttons & 32) oder Stifttaste
// (buttons & 2), soweit der Browser sie meldet.
const PALM_MS = 600, PALM_SIZE = 40;
const ignoredTouches = new Set();
let penSeen = false;
const isEraser = (e) => tool === 'eraser' ||
  (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) || (e.buttons & 2)));
const pressureOf = (e) => (e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5);
const isPalm = (e) => current?.pen || performance.now() - lastPen < PALM_MS ||
  Math.max(e.width || 0, e.height || 0) >= PALM_SIZE;

viewport.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    if (isPalm(e)) { ignoredTouches.add(e.pointerId); e.stopPropagation(); }
    return;   // sonst: OrbitControls dreht/zoomt
  }
  const draws = e.pointerType === 'pen' || (e.pointerType === 'mouse' && e.button === 0);
  if (!draws) return;
  e.stopPropagation(); e.preventDefault();
  if (e.pointerType === 'pen') { lastPen = performance.now(); penSeen = true; }
  controls.enabled = false;   // laufende Fingergesten (z. B. Handballen zuerst) anhalten
  try { viewport.setPointerCapture(e.pointerId); } catch { /* synthetische Ereignisse */ }
  const [x, y] = local(e);
  if (isEraser(e)) { current = { erase: true, id: e.pointerId, pen: e.pointerType === 'pen' }; eraseAt(x, y); return; }
  current = { id: e.pointerId, pts: [[x, y]], pr: [pressureOf(e)], color, pen: e.pointerType === 'pen' };
  drawStrokes();
}, true);
viewport.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'pen') lastPen = performance.now();   // auch beim Schweben
  if (e.pointerType === 'touch') {
    if (ignoredTouches.has(e.pointerId) || isPalm(e)) { ignoredTouches.add(e.pointerId); e.stopPropagation(); }
    return;
  }
  if (!current || current.id !== e.pointerId) return;
  e.stopPropagation();
  const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ce of coalesced.length ? coalesced : [e]) {
    const [x, y] = local(ce);
    if (current.erase) { eraseAt(x, y); continue; }
    const last = current.pts[current.pts.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) < 2) continue;
    current.pts.push([x, y]); current.pr.push(pressureOf(ce));
  }
  drawStrokes();
}, true);
const endPointer = (e) => {
  if (e.pointerType === 'touch') {
    if (ignoredTouches.delete(e.pointerId)) e.stopPropagation();
    return;
  }
  if (!current || current.id !== e.pointerId) return;
  e.stopPropagation();
  if (e.pointerType === 'pen') lastPen = performance.now();
  if (!current.erase) finishStroke(current);
  current = null;
  controls.enabled = true;
  drawStrokes();
};
viewport.addEventListener('pointerup', endPointer, true);
viewport.addEventListener('pointercancel', endPointer, true);

function updateMarkInfo() {
  const n = strokes.length;
  const onModel = strokes.filter((s) => s.anchors?.some((a) => a.on === 'modell')).length;
  const byColor = {};
  for (const s of strokes) byColor[s.color.name] = (byColor[s.color.name] || 0) + 1;
  const colors = Object.keys(byColor).length > 1 ? ' (' + Object.entries(byColor).map(([c, k]) => `${k}× ${c}`).join(', ') + ')' : '';
  $('#markinfo').textContent = n ? `${n} Strich${n > 1 ? 'e' : ''}${colors}${onModel ? `, ${onModel} auf dem Modell` : ''}` : '';
}

const r3 = (v) => v ? v.toArray().map((c) => +c.toFixed(2)) : null;
function marksPayload() {
  return strokes.map((s, i) => {
    const step = Math.max(1, Math.floor(s.anchors.length / 24));
    const hits = s.anchors.filter((_, k) => k % step === 0);
    const fmt = (a) => ({ p: r3(a.p), n: a.n ? r3(a.n) : undefined, body: a.body || undefined, auf: a.on });
    return {
      strich: i + 1,
      farbe: s.color.name,
      art: s.closed ? 'geschlossen (eingekreist)' : 'offen',
      punkte_entlang: hits.map(fmt),
      punkte_innen: s.inside.filter((a) => a.on === 'modell').map(fmt),
      bildschirm_box: bbox2d(s.pts),
    };
  });
}
function bbox2d(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs)), Math.round(Math.max(...ys))];
}

function snapshot() {
  // Ansicht plus Striche als ein Bild (lange Seite höchstens 1568 px).
  const w = viewport.clientWidth, h = viewport.clientHeight;
  const scale = Math.min(1, 1568 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  const ctx = c.getContext('2d');
  renderer.render(scene, camera);
  ctx.drawImage(renderer.domElement, 0, 0, c.width, c.height);
  ctx.drawImage(overlay, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

// ---------- Verbindung ----------
let ws = null;
let busy = false;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => $('#conn').classList.add('on');
  ws.onclose = () => { $('#conn').classList.remove('on'); setTimeout(connect, 1500); };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}
const send = (msg) => ws?.readyState === 1 ? ws.send(JSON.stringify(msg)) : toast('Keine Verbindung zum PC');

let lastModelRev = -1;
let pendingLocalUser = false;
let agentBlock = null;
function handle(m) {
  switch (m.type) {
    case 'hello':
      $('#log').innerHTML = '';
      replaying = true;
      for (const l of m.log) handle(l);
      replaying = false;
      setBusy(m.busy);
      break;
    case 'model':
      if (m.rev !== lastModelRev) { lastModelRev = m.rev; renderSketches(m.sketches); loadModel(m.rev, m.empty); }
      // Öffnen und Speichern passieren am PC; hier steht, was dort offen ist.
      $('#docname').textContent = (m.project ? m.project.split('/').pop() : `${m.name || 'Neues Bauteil'} (ungespeichert)`) + (m.dirty ? ' •' : '');
      $('#docname').title = m.project ? `${m.project}${m.dirty ? ' – ungespeicherte Änderungen, am PC speichern' : ''}` : 'Noch nicht gespeichert: am PC in SolidCraft speichern';
      $('#undo').disabled = !m.undo; $('#redo').disabled = !m.redo;
      break;
    case 'agent':
      if (m.kind === 'user' && pendingLocalUser) { pendingLocalUser = false; break; }
      agentMsg(m); break;
    case 'busy': setBusy(m.busy); if (!m.busy) { drawStrokes(); maybeAutoListen(); } break;
    case 'caps': caps = { stt: m.stt, tts: m.tts }; updateVoiceUi(); break;
    case 'status': if (m.solidcraft === false) toast('SolidCraft nicht erreichbar: ' + m.text); break;
    case 'error': toast(m.text); break;
    case 'reset': if (autoText && $('#text').value === autoText) $('#text').value = ''; autoText = null; $('#log').innerHTML = ''; firstModel = true; strokes = []; lastSent = null; $('#restore').disabled = true; drawStrokes(); break;
    case 'last_sketch':
      // Erst anwenden, wenn das Modell geladen ist (sonst setzt die erste Ansicht die Kamera zurück).
      if (modelRoot && !firstModel) applyLastSketch(m); else pendingSketch = m;
      break;
    case 'legend': legend = m.legend || {}; renderPalette(); break;
    case 'backend': {
      const b = $('#backend'), local = m.mode === 'lokal';
      b.classList.toggle('lokal', local);
      b.innerHTML = local ? '⌂<span>Lokal</span>' : '☁<span>Online</span>';
      b.title = local ? `KI lokal: ${m.local_model} über Ollama. Antippen für Online (Claude).`
                      : 'KI online: Claude. Antippen für Lokal (Ollama).';
      break;
    }
  }
}

function agentMsg(m) {
  const log = $('#log');
  const div = document.createElement('div');
  if (m.kind === 'user') {
    div.className = 'msg user';
    div.textContent = (m.text || '(Skizze)') + (m.marks ? `\n✎ ${m.marks} Strich${m.marks > 1 ? 'e' : ''}` : '');
    if (m.image) { const img = new Image(); img.src = m.image; div.append(img); }
    agentBlock = null;
  } else if (m.kind === 'text') {
    if (!replaying) say(m.text);
    div.className = 'msg agent'; div.textContent = m.text; agentBlock = null;
  } else if (m.kind === 'tool') {
    if (!agentBlock) { agentBlock = document.createElement('div'); agentBlock.className = 'tools'; log.append(agentBlock); }
    const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = m.name;
    agentBlock.append(chip); log.scrollTop = log.scrollHeight; return;
  } else if (m.kind === 'done') {
    agentBlock = null;
    if (m.ok) { div.className = 'msg done'; div.textContent = `fertig${m.ms ? ` · ${(m.ms / 1000).toFixed(0)} s` : ''}`; }
    else { div.className = 'msg error'; div.textContent = 'Fehler: ' + (m.error || 'unbekannt'); }
  } else if (m.kind === 'error') {
    div.className = 'msg error'; div.textContent = m.text;
  } else return;
  log.append(div);
  log.scrollTop = log.scrollHeight;
}

function setBusy(b) {
  busy = b;
  $('#busy').hidden = !b;
  $('#send').disabled = b;
  for (const id of ['#revert', '#backend']) $(id).disabled = b;
  if (b) { $('#undo').disabled = true; $('#redo').disabled = true; }
}

// ---------- Bedienung ----------
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return;
  const text = $('#text').value.trim();
  if (!text && !strokes.length) { toast('Schreib, was passieren soll, oder zeichne etwas.'); return; }
  for (const s of strokes) if (!s.anchors) { s.anchors = s.pts.map(([x, y]) => pick(x, y)); s.inside = s.closed ? interiorHits(s.pts) : []; }
  const image = snapshot();
  send({ type: 'prompt', text, image, marks: marksPayload(), camera: scCamera(), sketch: sketchPayload(),
         view: { width: viewport.clientWidth, height: viewport.clientHeight } });
  agentMsg({ kind: 'user', text, marks: strokes.length, image: strokes.length ? image : null });
  pendingLocalUser = true;
  $('#text').value = '';
  // Skizze mit Blickwinkel merken: „⤺ Skizze“ und „KI-Runde zurück“ holen sie zum Korrigieren zurück.
  if (strokes.length) {
    lastSent = { strokes: strokes.slice(), cam: camera.position.clone(), target: controls.target.clone() };
    $('#restore').disabled = false;
  }
  strokes = []; current = null; controls.enabled = true; drawStrokes('senden');
});
// ---------- Sprache in beide Richtungen ----------
// Eingabe: 🎤 antippen, sprechen, antippen → Text ins Eingabefeld (Whisper auf dem PC).
// Ausgabe: Antworten der KI werden vorgelesen (Piper auf dem PC), abschaltbar mit 🔊.
// Rückfrage (Antwort endet mit „?“) und 👂 an: nach dem Vorlesen hört das Mikrofon automatisch zu und
// stoppt nach einer Sprechpause; der erkannte Text landet im Eingabefeld, Senden bleibt beim Benutzer.
// Echo-Schutz: Aufnahme und Wiedergabe laufen nie gleichzeitig (Antippen von 🎤 beendet das Vorlesen),
// Echounterdrückung des Browsers ist an, und der PC verwirft Aufnahmen, die dem Vorgelesenen gleichen.
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* privat */ } },
};
let caps = { stt: true, tts: false };
let speakOn = store.get('studio.vorlesen', true);
let listenOn = store.get('studio.zuhoeren', true);
let audioCtx = null;
const speech = { queue: [], playing: false, source: null, spoken: 0, lastQuestion: false, pendingListen: false, lastHeard: '', echo: 0 };
let replaying = false;

function unlockAudio() {
  // Browser erlauben Ton erst nach einer Bedienung: beim ersten Antippen den Audiokontext öffnen.
  if (!audioCtx) { try { audioCtx = new AudioContext(); } catch { return; } }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
addEventListener('pointerdown', unlockAudio, true);
addEventListener('keydown', unlockAudio, true);

function say(text) {
  if (!speakOn || !caps.tts || !text.trim()) return;
  speech.queue.push(text);
  pumpSpeech();
}
async function pumpSpeech() {
  if (speech.playing || recorder || !speech.queue.length) return;
  const text = speech.queue.shift();
  speech.playing = true;
  updateVoiceUi();
  try {
    unlockAudio();
    const r = await fetch('/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const buf = await audioCtx.decodeAudioData(await r.arrayBuffer());
    if (!speech.playing) return;   // inzwischen abgebrochen
    await new Promise((resolve) => {
      const src = audioCtx.createBufferSource();
      src.buffer = buf; src.connect(audioCtx.destination);
      src.onended = resolve;
      speech.source = src;
      src.start();
    });
    speech.spoken++;
    speech.lastQuestion = /\?\s*$/.test(text.trim());
  } catch (e) { toast('Vorlesen: ' + e.message); speech.lastQuestion = false; }
  speech.source = null;
  speech.playing = false;
  updateVoiceUi();
  if (speech.queue.length) { pumpSpeech(); return; }
  if (speech.lastQuestion && listenOn && caps.stt) {
    speech.pendingListen = true;
    maybeAutoListen();
  }
}
function stopSpeaking() {
  speech.queue = [];
  speech.pendingListen = false;
  if (speech.source) { try { speech.source.stop(); } catch { /* schon zu Ende */ } }
  speech.playing = false;
  updateVoiceUi();
}
function maybeAutoListen() {
  // Erst zuhören, wenn die KI fertig ist und nichts mehr vorgelesen wird (kein Echo).
  if (!speech.pendingListen || busy || speech.playing || recorder) return;
  speech.pendingListen = false;
  setTimeout(() => { if (!speech.playing && !recorder) startRecording({ auto: true }); }, 400);
}
function updateVoiceUi() {
  $('#say').hidden = !caps.tts; $('#listen').hidden = !caps.tts || !caps.stt; $('#mic').hidden = !caps.stt;
  $('#say').textContent = speakOn ? '🔊' : '🔇';
  $('#say').classList.toggle('on', speakOn);
  $('#say').title = speakOn ? 'Vorlesen ist an (antippen: aus)' : 'Vorlesen ist aus (antippen: an)';
  $('#listen').classList.toggle('on', listenOn);
  $('#listen').title = listenOn ? 'Nach einer Rückfrage automatisch zuhören: an' : 'Nach einer Rückfrage automatisch zuhören: aus';
  $('#mic').classList.toggle('speaking', speech.playing);
}
$('#say').onclick = () => { speakOn = !speakOn; store.set('studio.vorlesen', speakOn); if (!speakOn) stopSpeaking(); updateVoiceUi(); };
$('#listen').onclick = () => { listenOn = !listenOn; store.set('studio.zuhoeren', listenOn); updateVoiceUi(); };

let recorder = null;
function watchSilence(stream, done) {
  // Einfache Sprechpausen-Erkennung über die Lautstärke (RMS) des Mikrofons.
  unlockAudio();
  const src = audioCtx.createMediaStreamSource(stream);
  const an = audioCtx.createAnalyser(); an.fftSize = 2048; src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const t0 = performance.now(); let spoke = false, quietSince = t0;
  const iv = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0; for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length), now = performance.now();
    if (rms > 0.015) { spoke = true; quietSince = now; }
    if ((spoke && now - quietSince > 1200) || (!spoke && now - t0 > 7000) || now - t0 > 30000) {
      clearInterval(iv); src.disconnect(); done(spoke);
    }
  }, 100);
  return () => { clearInterval(iv); src.disconnect(); };
}
async function startRecording({ auto = false } = {}) {
  stopSpeaking();   // nie gleichzeitig vorlesen und aufnehmen
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) { toast('Kein Mikrofon-Zugriff: ' + e.message); return; }
  const type = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  recorder = rec;
  rec.auto = auto;
  rec.discard = false;
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    rec.stopWatch?.();
    stream.getTracks().forEach((t) => t.stop());
    $('#mic').classList.remove('rec');
    if (rec.discard) { recorder = null; toast('Keine Antwort gehört.'); pumpSpeech(); return; }
    $('#mic').classList.add('wait');
    try {
      const r = await fetch('/stt', { method: 'POST', body: new Blob(chunks, { type: rec.mimeType }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      speech.lastHeard = j.text || '';
      if (j.echo) { speech.echo++; toast('Eigene Sprachausgabe im Mikrofon erkannt und verworfen.'); }
      else if (j.text) {
        const t = $('#text');
        t.value = (t.value.trim() ? t.value.trim() + ' ' : '') + j.text;
        t.focus(); t.setSelectionRange(t.value.length, t.value.length);
      } else toast('Nichts verstanden.');
    } catch (e) { toast('Spracherkennung: ' + e.message); }
    $('#mic').classList.remove('wait');
    recorder = null;
    pumpSpeech();
  };
  rec.start();
  $('#mic').classList.add('rec');
  if (auto) {
    toast('Ich höre zu …');
    rec.stopWatch = watchSilence(stream, (spoke) => {
      if (rec.state !== 'recording') return;
      rec.discard = !spoke;
      rec.stop();
    });
  }
}
$('#mic').addEventListener('click', () => {
  if ($('#mic').classList.contains('wait')) return;
  if (recorder && recorder.state === 'recording') recorder.stop(); else startRecording();
});

$('#text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composer').requestSubmit();
});

function renderPalette() {
  const pal = $('#palette');
  pal.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.dataset.color = c.name;
    b.className = c === color ? 'active' : '';
    const meaning = legend[c.name];
    b.title = meaning ? `${c.name}: ${meaning}` : `${c.name} (Bedeutung sagst du der KI, z. B. „${c.name} ist …“)`;
    b.innerHTML = `<i class="swatch" style="background:${c.hex}"></i><span>${meaning || c.name}</span>`;
    b.onclick = () => {
      color = c;
      if (tool === 'eraser') document.querySelector('[data-tool="pen"]').click();
      renderPalette();
    };
    pal.append(b);
  }
}
renderPalette();

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
  tool = b.dataset.tool;
  document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
}));
$('#clear').onclick = () => { strokes = []; drawStrokes(); };
$('#undostroke').onclick = () => { strokes.pop(); drawStrokes(); };
$('#undo').onclick = () => send({ type: 'undo' });
$('#redo').onclick = () => send({ type: 'redo' });
$('#revert').onclick = () => {
  if (!confirm('Letzte KI-Runde komplett zurücknehmen? Deine Skizze dazu kommt zum Korrigieren zurück.')) return;
  send({ type: 'revert_turn' });
  restoreSketch();
};
// Zuletzt gesendete Skizze zurückholen (mit dem Blickwinkel, in dem sie gezeichnet wurde).
let lastSent = null;
function restoreSketch() {
  if (!lastSent) return;
  camera.position.copy(lastSent.cam);
  controls.target.copy(lastSent.target);
  controls.update();
  const have = new Set(strokes);
  strokes = [...lastSent.strokes.filter((s) => !have.has(s)), ...strokes];
  drawStrokes('zurueckgeholt');
  toast('Skizze zurückgeholt: korrigieren und neu senden.');
}
$('#restore').onclick = restoreSketch;

// ---------- Skizze über Neustarts hinweg ----------
// Jede Runde speichert die vollständigen Striche (3D-Anker, Druck, Farbe) und die Kamera. Beim Öffnen
// eines Projekts schickt der PC die letzte Runde. War sie nach dem letzten Speichern (ihr Ergebnis
// fehlt also im Modell), kommt sie samt Text sofort zurück, sonst liegt sie unter „⤺ Skizze“ bereit.
let pendingSketch = null;
let autoText = null;   // vom Laden eingesetzter Text: beim Wechsel des Projekts wieder entfernen
const r3a = (v) => v.toArray().map((x) => +x.toFixed(3));
function sketchPayload() {
  const a = (x) => ({ p: r3a(x.p), n: x.n ? r3a(x.n) : null, body: x.body || null, on: x.on });
  return {
    cam: { pos: r3a(camera.position), target: r3a(controls.target) },
    strokes: strokes.map((s) => ({ farbe: s.color.name, closed: !!s.closed,
      pr: s.pr.map((v) => +(+v).toFixed(2)), anchors: s.anchors.map(a), inside: (s.inside || []).map(a) })),
  };
}
function camFromSc(k) {
  // Umkehrung von scCamera(): yaw 0 = Blick entlang +Y, pitch positiv = von oben.
  const dir = new THREE.Vector3(Math.sin(k.yaw) * Math.cos(k.pitch), Math.cos(k.yaw) * Math.cos(k.pitch), -Math.sin(k.pitch));
  const target = new THREE.Vector3(...k.target);
  return { target, pos: target.clone().addScaledVector(dir, -k.distance) };
}
function applyLastSketch(m) {
  const vec = (v) => (v ? new THREE.Vector3(...v) : null);
  const anchor = (x) => ({ p: vec(x.p), n: vec(x.n), body: x.body || null, on: x.on || x.auf || 'modell' });
  let list = [], cam = null;
  if (m.skizze) {
    cam = { pos: vec(m.skizze.cam.pos), target: vec(m.skizze.cam.target) };
    list = m.skizze.strokes.map((s) => ({ farbe: s.farbe, closed: s.closed, pr: s.pr,
      anchors: s.anchors.map(anchor), inside: (s.inside || []).map(anchor) }));
  } else if (m.markierungen) {
    // Ältere Runden ohne vollständige Striche: aus den übertragenen 3D-Punkten nachbilden.
    if (m.kamera) cam = camFromSc(m.kamera);
    list = m.markierungen.map((k) => {
      const anchors = (k.punkte_entlang || []).map(anchor);
      const closed = String(k.art || '').startsWith('geschlossen');
      if (closed && anchors.length > 2) anchors.push(anchors[0]);
      return { farbe: k.farbe, closed, pr: anchors.map(() => 0.5), anchors, inside: (k.punkte_innen || []).map(anchor) };
    });
  }
  list = list.filter((s) => s.anchors.length);
  if (!list.length) return;
  if (cam) {
    camera.position.copy(cam.pos); controls.target.copy(cam.target);
    const dist = cam.pos.distanceTo(cam.target);
    camera.near = dist / 100; camera.far = dist * 100; camera.updateProjectionMatrix();
    controls.update();
  }
  const restored = list.map((s) => ({ color: COLORS.find((c) => c.name === s.farbe) || COLORS[0],
    closed: s.closed, pr: s.pr, anchors: s.anchors, inside: s.inside, cam: 'gespeichert',
    pts: s.anchors.map((a) => project(a.p).slice(0, 2)) }));
  lastSent = { strokes: restored, cam: camera.position.clone(), target: controls.target.clone() };
  $('#restore').disabled = false;
  const zeit = m.zeit ? new Date(m.zeit).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '';
  if (m.unsaved) {
    strokes = [...restored];
    if (!$('#text').value.trim() && m.text) { $('#text').value = m.text; autoText = m.text; }
    drawStrokes('geladen');
    toast(`Letzte Runde vom ${zeit} war nicht gespeichert: Skizze und Text sind zurück. Prüfen und senden.`);
  } else {
    drawStrokes('geladen');
    toast(`Letzte Skizze vom ${zeit} liegt unter ⤺ Skizze bereit.`);
  }
}
$('#fit').onclick = () => fitView();
$('#top').onclick = () => fitView(VIEW_TOP.clone());
$('#iso').onclick = () => fitView(VIEW_ISO.clone());
$('#topc').onclick = () => { send({ type: 'camera', camera: scCamera() }); toast('Ansicht an PC übergeben'); };
$('#backend').onclick = () => {
  const local = $('#backend').classList.contains('lokal');
  if (confirm(local ? 'Auf Online (Claude) umschalten? Das Gespräch mit dem Agenten beginnt neu.'
                    : 'Auf Lokal (Ollama) umschalten? Das Gespräch mit dem Agenten beginnt neu.'))
    send({ type: 'backend', mode: local ? 'online' : 'lokal' });
};
$('#stop').onclick = () => send({ type: 'stop' });
$('#fullscreen').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();


let toastTimer;
function toast(text) {
  const t = $('#toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// Für automatische Tests: Weltpunkt (mm) → Bildschirmpunkt in der Ansicht.
window.studioDebug = { worldToScreen: (x, y, z) => project(new THREE.Vector3(x, y, z)), state: () => ({ strokes: strokes.length, current: !!current, tool, color: color.name, legend,
    strokeColors: strokes.map((s) => s.color.name), pressures: strokes.map((s) => s.pr) }),
  marks: () => marksPayload(),
  sketchLines: () => sketchRoot.children.length,
  sketch: () => sketchPayload(),
  strokeScreens: () => strokes.map((s) => s.anchors.map((a) => project(a.p).slice(0, 2))),
  text: () => document.querySelector('#text').value,
  camera: () => camera.position.toArray().map((v) => +v.toFixed(3)),
  input: () => ({ penSeen, ignoredTouches: ignoredTouches.size, controls: controls.enabled }),
  speech: () => ({ on: speakOn, listen: listenOn, caps, playing: speech.playing, queue: speech.queue.length,
    spoken: speech.spoken, recording: !!recorder, auto: !!recorder?.auto, lastHeard: speech.lastHeard, echo: speech.echo,
    text: $('#text').value }),
  say: (text) => say(text),
  drawLog: () => drawLog.slice(-12),
  overlayPixels: () => {
    const d = octx.getImageData(0, 0, overlay.width, overlay.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    return n;
  },
  // Anteil der Pixel im übertragenen Bild, die der Farbe nahekommen (Prüfung „Farbe im Bild“).
  imageHasColor: async (hex) => {
    const img = new Image(); img.src = snapshot(); await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 60) n++;
    return n;
  },
};

if (location.search.includes('t=')) history.replaceState(null, '', '/');
updateVoiceUi();
fitView(VIEW_ISO.clone());
resize();
animate();
connect();
