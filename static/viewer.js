// 3D-просмотрщик моделей и генерация миниатюр (three.js)
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AMFLoader } from 'three/addons/loaders/AMFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MODEL_COLOR = 0xb9bec8;
const THUMB_W = 640;
const THUMB_H = 480;
const OCCT_URL = '/static/vendor/occt/';

// Форматы 3D-печати и CAD обычно Z-up, three.js — Y-up
const Z_UP = new Set(['stl', '3mf', 'amf', 'step', 'stp', 'iges', 'igs']);
const CAD = new Set(['step', 'stp', 'iges', 'igs']);

const VIEWS = {
  iso: [1, 0.75, 1.2],
  front: [0, 0, 1],
  top: [0, 1, 0.0001],
  side: [1, 0, 0],
};

export const isCadFormat = (ext) => CAD.has(ext);

// ---------- загрузка ----------

let occtPromise = null;

/** CAD-движок (OpenCascade, wasm) подгружается только при первом открытии STEP/IGES. */
function getOcct() {
  if (!occtPromise) {
    occtPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${OCCT_URL}occt-import-js.js`;
      script.onload = () => resolve(window.occtimportjs({ locateFile: (f) => OCCT_URL + f }));
      script.onerror = () => reject(new Error('Не удалось загрузить CAD-модуль'));
      document.head.append(script);
    }).catch((e) => {
      occtPromise = null;
      throw e;
    });
  }
  return occtPromise;
}

async function loadCad(buffer, ext) {
  const occt = await getOcct();
  const bytes = new Uint8Array(buffer);
  const result = ext === 'step' || ext === 'stp' ? occt.ReadStepFile(bytes, null) : occt.ReadIgesFile(bytes, null);
  if (!result?.success || !result.meshes?.length) throw new Error('Не удалось прочитать CAD-файл');
  const group = new THREE.Group();
  for (const m of result.meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    if (m.index) g.setIndex(Array.from(m.index.array));
    group.add(new THREE.Mesh(g));
  }
  return group;
}

async function loadRaw(buffer, ext) {
  switch (ext) {
    case 'stl': return new THREE.Mesh(new STLLoader().parse(buffer));
    case 'obj': return new OBJLoader().parse(new TextDecoder().decode(buffer));
    case '3mf': return new ThreeMFLoader().parse(buffer);
    case 'amf': return new AMFLoader().parse(buffer);
    case 'ply': {
      const g = new PLYLoader().parse(buffer);
      return g.index ? new THREE.Mesh(g) : new THREE.Points(g); // без граней — облако точек
    }
    case 'glb':
    case 'gltf':
      return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', (gltf) => resolve(gltf.scene),
        (e) => reject(new Error(e?.message || 'Не удалось прочитать GLTF'))));
    case 'step': case 'stp': case 'iges': case 'igs':
      return loadCad(buffer, ext);
    default:
      throw new Error(`Формат .${ext} не поддерживается`);
  }
}

function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat()) {
      if (!m) continue;
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

/**
 * Разбирает файл модели любого поддерживаемого формата.
 * Результат — группа мешей с единым «глиняным» материалом, стоящая на полу по центру.
 * В userData: box, sphere, material, info (габариты в осях исходного файла и число треугольников).
 */
export async function loadModel(buffer, ext) {
  const raw = await loadRaw(buffer, ext);
  raw.updateMatrixWorld(true);
  const zUp = Z_UP.has(ext);
  const toYUp = new THREE.Matrix4().makeRotationX(zUp ? -Math.PI / 2 : 0);
  const material = new THREE.MeshStandardMaterial({ color: MODEL_COLOR, roughness: 0.62, metalness: 0.02, side: THREE.DoubleSide });
  const group = new THREE.Group();
  let triangles = 0;
  let points = null;

  raw.traverse((o) => {
    if (!(o.isMesh || o.isPoints) || !o.geometry?.attributes.position?.count) return;
    let g = o.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    g.morphAttributes = {};
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toYUp, o.matrixWorld));
    if (o.isPoints) {
      points ||= new THREE.PointsMaterial({ color: MODEL_COLOR, size: 1 });
      group.add(new THREE.Points(g, points));
      return;
    }
    if (!g.attributes.normal || ext === 'stl') {
      // без нормалей — плоское затенение по граням: острые кромки остаются острыми
      if (g.index) g = g.toNonIndexed();
      g.computeVertexNormals();
    }
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    group.add(new THREE.Mesh(g, material));
  });
  disposeTree(raw);
  if (!group.children.length) {
    material.dispose();
    throw new Error('В файле нет геометрии');
  }

  let box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new THREE.Vector3());
  const offset = new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z);
  for (const child of group.children) child.geometry.applyMatrix4(offset);
  box = new THREE.Box3().setFromObject(group);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (points) points.size = Math.max(sphere.radius / 250, 1e-4);

  const size = box.getSize(new THREE.Vector3());
  group.userData = {
    box, sphere, material,
    info: { x: size.x, y: zUp ? size.z : size.y, z: zUp ? size.y : size.z, triangles: Math.round(triangles) },
  };
  return group;
}

export function disposeModel(model) {
  disposeTree(model);
}

// ---------- сцена и камера ----------

function addLights(scene, camera) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6d7a8c, 1.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1, 1.5, 0.5);
  key.target.position.set(0, 0, -1);
  camera.add(key, key.target);
  scene.add(camera);
}

function fitCamera(camera, model, controls, view = 'iso', margin = 1.05) {
  const { center, radius } = model.userData.sphere;
  const r = radius || 1;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const fov = camera.aspect < 1 ? 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect) : vFov;
  const dist = (r / Math.sin(fov / 2)) * margin;
  const dir = new THREE.Vector3(...VIEWS[view]).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  if (controls) {
    controls.target.copy(center);
    controls.maxDistance = dist * 20;
    controls.update();
  }
}

// ---------- миниатюры ----------

let thumbRenderer = null;
function getThumbRenderer() {
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
    thumbRenderer.setSize(THUMB_W, THUMB_H, false);
    thumbRenderer.setClearColor(0x000000, 0);
  }
  return thumbRenderer;
}

function renderToBlob(model, setupCamera) {
  const renderer = getThumbRenderer();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, THUMB_W / THUMB_H, 0.1, 1000);
  const copy = model.clone(); // геометрия и материал общие, модель остаётся в просмотрщике
  copy.userData = model.userData;
  const wire = model.userData.material.wireframe;
  model.userData.material.wireframe = false;
  scene.add(copy);
  addLights(scene, camera);
  setupCamera(camera);
  renderer.render(scene, camera);
  model.userData.material.wireframe = wire;
  return new Promise((resolve, reject) =>
    renderer.domElement.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось создать миниатюру'))), 'image/png'));
}

export function thumbnailFromModel(model) {
  return renderToBlob(model, (cam) => fitCamera(cam, model, null, 'iso', 0.95));
}

/** Миниатюра PNG для файла модели (используется при загрузке). */
export async function thumbnailFromBuffer(buffer, ext) {
  const model = await loadModel(buffer, ext);
  try {
    return await thumbnailFromModel(model);
  } finally {
    disposeModel(model);
  }
}

function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(x));
  const n = x / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

// ---------- интерактивный просмотрщик ----------

/** Вращение, масштаб, сдвиг. */
export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.append(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    addLights(this.scene, this.camera);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setModel(model) {
    this.clearModel();
    this.model = model;
    this.scene.add(model);

    const size = model.userData.box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 1e-3) * 1.6;
    const step = niceStep(span / 10);
    const divisions = Math.max(2, Math.ceil(span / step));
    this.grid = new THREE.GridHelper(divisions * step, divisions, 0x8a93a3, 0x8a93a3);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.35;
    this.scene.add(this.grid);
    this.setView('iso');
  }

  setView(view) {
    if (this.model) fitCamera(this.camera, this.model, this.controls, view);
  }

  setWireframe(on) {
    if (this.model) this.model.userData.material.wireframe = on;
  }

  setGrid(on) {
    if (this.grid) this.grid.visible = on;
  }

  /** Миниатюра с текущего ракурса камеры. */
  snapshot() {
    const src = this.camera;
    return renderToBlob(this.model, (cam) => {
      cam.fov = src.fov;
      cam.near = src.near;
      cam.far = src.far;
      cam.position.copy(src.position);
      cam.quaternion.copy(src.quaternion);
      cam.updateProjectionMatrix();
    });
  }

  clearModel() {
    if (this.model) {
      this.scene.remove(this.model);
      disposeModel(this.model);
      this.model = null;
    }
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
      this.grid = null;
    }
  }

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clearModel();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
