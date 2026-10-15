// 3D-просмотрщик STL и генерация миниатюр (three.js)
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MODEL_COLOR = 0xb9bec8;
const THUMB_W = 640;
const THUMB_H = 480;

const VIEWS = {
  iso: [1, 0.75, 1.2],
  front: [0, 0, 1],
  top: [0, 1, 0.0001],
  side: [1, 0, 0],
};

/** Разбирает STL (бинарный или ASCII) и ставит модель на «пол», по центру. */
export function parseSTL(buffer) {
  const geometry = new STLLoader().parse(buffer);
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count === 0) throw new Error('Файл пустой или повреждён');
  if (geometry.getAttribute('color')) geometry.deleteAttribute('color');
  geometry.rotateX(-Math.PI / 2); // STL обычно Z-up, в three.js — Y-up
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const center = bb.getCenter(new THREE.Vector3());
  geometry.translate(-center.x, -bb.min.y, -center.z);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Габариты в исходных осях STL (мм) и количество треугольников. */
export function geometryInfo(geometry) {
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  return { x: size.x, y: size.z, z: size.y, triangles: geometry.getAttribute('position').count / 3 };
}

function makeMaterial() {
  return new THREE.MeshStandardMaterial({ color: MODEL_COLOR, roughness: 0.62, metalness: 0.02, side: THREE.DoubleSide });
}

function addLights(scene, camera) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6d7a8c, 1.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1, 1.5, 0.5);
  key.target.position.set(0, 0, -1);
  camera.add(key, key.target);
  scene.add(camera);
}

function fitCamera(camera, geometry, controls, view = 'iso', margin = 1.05) {
  const { center, radius } = geometry.boundingSphere;
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

function renderToBlob(geometry, setupCamera) {
  const renderer = getThumbRenderer();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, THUMB_W / THUMB_H, 0.1, 1000);
  const material = makeMaterial();
  scene.add(new THREE.Mesh(geometry, material));
  addLights(scene, camera);
  setupCamera(camera);
  renderer.render(scene, camera);
  material.dispose();
  return new Promise((resolve, reject) =>
    renderer.domElement.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось создать миниатюру'))), 'image/png'));
}

export function thumbnailFromGeometry(geometry) {
  return renderToBlob(geometry, (cam) => fitCamera(cam, geometry, null, 'iso', 0.95));
}

/** Миниатюра PNG для STL-файла (используется при загрузке). */
export async function thumbnailFromBuffer(buffer) {
  const geometry = parseSTL(buffer);
  try {
    return await thumbnailFromGeometry(geometry);
  } finally {
    geometry.dispose();
  }
}

function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(x));
  const n = x / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

/** Интерактивный просмотрщик: вращение, масштаб, сдвиг. */
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

  setGeometry(geometry) {
    this.clearModel();
    this.geometry = geometry;
    this.mesh = new THREE.Mesh(geometry, makeMaterial());
    this.scene.add(this.mesh);

    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 1) * 1.6;
    const step = niceStep(span / 10);
    const divisions = Math.max(2, Math.ceil(span / step));
    this.grid = new THREE.GridHelper(divisions * step, divisions, 0x8a93a3, 0x8a93a3);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.35;
    this.scene.add(this.grid);
    this.setView('iso');
  }

  setView(view) {
    if (this.geometry) fitCamera(this.camera, this.geometry, this.controls, view);
  }

  setWireframe(on) {
    if (this.mesh) this.mesh.material.wireframe = on;
  }

  setGrid(on) {
    if (this.grid) this.grid.visible = on;
  }

  /** Миниатюра с текущего ракурса камеры. */
  snapshot() {
    const src = this.camera;
    return renderToBlob(this.geometry, (cam) => {
      cam.fov = src.fov;
      cam.near = src.near;
      cam.far = src.far;
      cam.position.copy(src.position);
      cam.quaternion.copy(src.quaternion);
      cam.updateProjectionMatrix();
    });
  }

  clearModel() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.material.dispose();
      this.mesh.geometry.dispose();
      this.mesh = null;
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
