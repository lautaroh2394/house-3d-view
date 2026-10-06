import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Agregar en modelList.js cada modelo publicado. Conservar los archivos .glb a nivel raíz.
let modelsResponse = await fetch("/models.js")
const MODELS = await modelsResponse.json()
const MAX_MODEL_BYTES = 300 * 1024 * 1024;
const MAX_NODES = 30000;
const MAX_MESHES = 20000;
const MAX_ACCESSORS = 50000;
const sceneHost = document.getElementById("scene");
const modelSelect = document.getElementById("modelSelect");
const modelCount = document.getElementById("modelCount");
const fileInput = document.getElementById("fileInput");
const loadingLayer = document.getElementById("loadingLayer");
const loadingCard = document.getElementById("loadingCard");
const loadingTitle = document.getElementById("loadingTitle");
const loadingCopy = document.getElementById("loadingCopy");
const emptyActions = document.getElementById("emptyActions");
const toast = document.getElementById("toast");

const scene = new THREE.Scene();
scene.background = new THREE.Color("#dfe5dd");
scene.fog = new THREE.Fog("#dfe5dd", 40, 110);

const DEFAULT_FOV = 68;
const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.05, 180);
camera.rotation.order = "YXZ";

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.domElement.setAttribute("aria-hidden", "true");
sceneHost.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xf8f8f0, 0x687766, 2.0));
const sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
sun.position.set(-8, 14, 8);
scene.add(sun);

const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({ color: 0xcbd4ca, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.035;
ground.receiveShadow = false;
scene.add(ground);

const keys = new Set();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const desiredStep = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
let deleteWheelSetEvents = false;

let modelRoot = null;
let modelBounds = null;
let homePosition = new THREE.Vector3(0, 1.62, 4);
let yaw = 0;
let pitch = 0;
let dragPointer = null;
let lastFrame = performance.now();
let loadToken = 0;
let activeAbortController = null;
let temporaryCounter = 0;
let toastTimer = 0;

const input = {
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0
};

function resize() {
    const width = Math.max(1, sceneHost.clientWidth);
    const height = Math.max(1, sceneHost.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
}

function setCameraAngles() {
    camera.rotation.set(pitch, yaw, 0, "YXZ");
}

function showToast(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
    toast.classList.remove("visible");
    }, 3200);
}

function setLoading(title, copy, isError) {
    loadingLayer.hidden = false;
    loadingCard.classList.toggle("is-error", Boolean(isError));
    loadingTitle.textContent = title;
    loadingCopy.textContent = copy;
    emptyActions.hidden = !isError;
}

function hideLoading() {
    loadingLayer.hidden = true;
    loadingCard.classList.remove("is-error");
}

function updateModelCount() {
    const published = MODELS.length;
    const temporary = temporaryCounter;
    const total = published + temporary;
    modelCount.textContent = total + (total === 1 ? " modelo en esta sesión" : " modelos en esta sesión");
}

function addOption(id, label) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    modelSelect.appendChild(option);
}

function disposeCurrentModel() {
    if (!modelRoot) return;
    scene.remove(modelRoot);
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    modelRoot.traverse(function (object) {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
    for (const material of list) {
        materials.add(material);
        for (const value of Object.values(material)) {
        if (value && value.isTexture) textures.add(value);
        }
    }
    });
    for (const texture of textures) {
    if (texture.image && typeof texture.image.close === "function") texture.image.close();
    texture.dispose();
    }
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    modelRoot = null;
    modelBounds = null;
}

function validateModelFile(file) {
    if (!file || typeof file.name !== "string") throw new Error("Elegí un archivo GLB válido.");
    if (!file.name.toLowerCase().endsWith(".glb")) throw new Error("El formato admitido es .glb.");
    const allowedMime = ["model/gltf-binary", "application/octet-stream", "binary/octet-stream"];
    if (file.type && !allowedMime.includes(file.type.toLowerCase())) {
    throw new Error("El archivo no declara un tipo GLB compatible.");
    }
    if (file.size < 20 || file.size > MAX_MODEL_BYTES) {
    throw new Error("El archivo debe pesar entre 20 bytes y 300 MB.");
    }
}

function inspectGLB(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 20 || buffer.byteLength > MAX_MODEL_BYTES) {
    throw new Error("El archivo no tiene un tamaño GLB válido.");
    }
    const view = new DataView(buffer);
    const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 4));
    const version = view.getUint32(4, true);
    const declaredLength = view.getUint32(8, true);
    const jsonLength = view.getUint32(12, true);
    const jsonType = view.getUint32(16, true);
    if (magic !== "glTF" || version !== 2 || declaredLength !== buffer.byteLength || jsonType !== 0x4e4f534a) {
    throw new Error("El archivo no es un GLB 2 válido.");
    }
    if (jsonLength < 2 || jsonLength > buffer.byteLength - 20) {
    throw new Error("El modelo contiene una estructura GLB inválida.");
    }

    let document;
    try {
    const jsonText = new TextDecoder("utf-8", { fatal: true })
        .decode(new Uint8Array(buffer, 20, jsonLength))
        .replace(/[\u0000\u0020]+$/u, "");
    document = JSON.parse(jsonText);
    } catch {
    throw new Error("No se pudo leer la estructura del modelo.");
    }

    if (!document || !document.asset || document.asset.version !== "2.0") {
    throw new Error("El modelo debe usar glTF 2.0.");
    }
    for (const key of ["nodes", "meshes", "accessors", "images", "buffers", "bufferViews", "textures"]) {
    if (document[key] !== undefined && !Array.isArray(document[key])) {
        throw new Error("El modelo contiene una estructura glTF inválida.");
    }
    }
    if ((document.nodes || []).length > MAX_NODES
    || (document.meshes || []).length > MAX_MESHES
    || (document.accessors || []).length > MAX_ACCESSORS
    || (document.images || []).length > 2048
    || (document.bufferViews || []).length > 100000) {
    throw new Error("El modelo supera los límites de complejidad admitidos.");
    }
    for (const image of document.images || []) {
    if (!image || typeof image !== "object") throw new Error("El modelo contiene una imagen inválida.");
    if (typeof image.uri === "string" && !/^data:image\/(?:png|jpeg|webp|avif);/i.test(image.uri)) {
        throw new Error("El modelo intenta cargar una imagen externa. Se admiten texturas incluidas en el GLB.");
    }
    }
    for (const item of document.buffers || []) {
    if (!item || typeof item !== "object") throw new Error("El modelo contiene un buffer inválido.");
    if (typeof item.uri === "string") {
        throw new Error("El modelo intenta cargar un archivo externo. Se admiten recursos incluidos en el GLB.");
    }
    }
    return document;
}

function createLoader() {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(function (url) {
    if (/^data:image\/(?:png|jpeg|webp|avif);/i.test(url)) return url;
    if (url.startsWith("blob:")) {
        try {
        if (new URL(url).origin === window.location.origin) return url;
        } catch {
        // Malformed object URLs are rejected below.
        }
    }
    throw new Error("Se bloqueó una referencia externa incluida en el modelo.");
    });
    return new GLTFLoader(manager);
}

async function fetchPublishedModel(model, token) {
    const url = new URL(model.url, window.location.href);
    
    activeAbortController = new AbortController();
    const response = await fetch(url.href, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    cache: "force-cache",
    signal: activeAbortController.signal
    });
    if (!response.ok) throw new Error("No se encontró el archivo del modelo publicado.");
    const announcedSize = Number(response.headers.get("content-length") || 0);
    if (announcedSize > MAX_MODEL_BYTES) throw new Error("El modelo publicado supera el límite de 300 MB.");
    if (token !== loadToken) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_MODEL_BYTES) throw new Error("El modelo publicado supera el límite de 300 MB.");
    return buffer;
}

function normalizeAndAdd(root) {
    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(root);
    if (bounds.isEmpty()) throw new Error("El modelo no contiene geometría visible.");
    const size = bounds.getSize(new THREE.Vector3());
    const longestSide = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(longestSide) || longestSide <= 0) throw new Error("El modelo tiene dimensiones inválidas.");

    root.scale.multiplyScalar(26 / longestSide);
    root.updateMatrixWorld(true);
    const scaledBounds = new THREE.Box3().setFromObject(root);
    const scaledCenter = scaledBounds.getCenter(new THREE.Vector3());
    root.position.x -= scaledCenter.x;
    root.position.y -= scaledBounds.min.y;
    root.position.z -= scaledCenter.z;
    root.updateMatrixWorld(true);
    modelBounds = new THREE.Box3().setFromObject(root);
    scene.add(root);
    modelRoot = root;

    const finalSize = modelBounds.getSize(new THREE.Vector3());
    const startDepth = Math.min(Math.max(finalSize.z * 0.18, 2.8), 6.5);
    homePosition = new THREE.Vector3(0, 3.5, startDepth);
    resetView();
}

function resetView() {
    if (!modelRoot) return;
    camera.position.copy(homePosition);
    camera.fov = DEFAULT_FOV;
    camera.updateProjectionMatrix();
    yaw = 0;
    pitch = 0;
    setCameraAngles();
    input.moveX = input.moveY = input.lookX = input.lookY = 0;
    resetStick("moveStick");
    resetStick("lookStick");
}

async function displayBuffer(buffer, token) {
    if (token !== loadToken) return;
    inspectGLB(buffer);
    setLoading("Armando la casa", "El archivo ya está en el navegador; estamos preparando la vista 3D.", false);
    const gltf = await createLoader().parseAsync(buffer, "");
    if (token !== loadToken) {
    disposeTree(gltf.scene);
    return;
    }
    normalizeAndAdd(gltf.scene);
    hideLoading();
}

function disposeTree(root) {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    root.traverse(function (object) {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
    for (const material of list) {
        materials.add(material);
        for (const value of Object.values(material)) {
        if (value && value.isTexture) textures.add(value);
        }
    }
    });
    for (const texture of textures) {
    if (texture.image && typeof texture.image.close === "function") texture.image.close();
    texture.dispose();
    }
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
}

async function loadPublished(model) {
    const token = ++loadToken;
    if (activeAbortController) activeAbortController.abort();
    activeAbortController = null;
    disposeCurrentModel();
    setLoading("Cargando modelo", "Descargando el archivo publicado y preparando el recorrido.", false);
    try {
    const buffer = await fetchPublishedModel(model, token);
    if (!buffer || token !== loadToken) return;
    await displayBuffer(buffer, token);
    } catch {
    if (token !== loadToken) return;
    setLoading(
        "No encontramos el modelo",
        "Revisá que el archivo .glb publicado esté junto a esta página y volvé a intentar, o elegí un modelo de tu dispositivo.",
        true
    );
    }
}

async function loadLocalFile(file, id) {
    const token = ++loadToken;
    if (activeAbortController) activeAbortController.abort();
    activeAbortController = null;
    disposeCurrentModel();
    setLoading("Abriendo modelo local", "El archivo se procesa en este navegador y no se envía a un servidor.", false);
    try {
    validateModelFile(file);
    const buffer = await file.arrayBuffer();
    if (token !== loadToken) return;
    const optionId = id || "local-" + (++temporaryCounter);
    if (!id) {
        addOption(optionId, "Vista local · " + file.name);
        localModels.set(optionId, file);
        modelSelect.value = optionId;
        updateModelCount();
    }
    await displayBuffer(buffer, token);
    } catch {
    if (token !== loadToken) return;
    setLoading(
        "No pudimos abrir el GLB",
        "Elegí un archivo glTF 2.0 válido de hasta 300 MB. El modelo debe incluir sus texturas dentro del archivo.",
        true
    );
    }
}

function resetStick(id) {
    const element = document.getElementById(id);
    const thumb = element.querySelector(".stick-thumb");
    thumb.style.transform = "translate(0px, 0px)";
}

function setupStick(id, kind) {
    const element = document.getElementById(id);
    const thumb = element.querySelector(".stick-thumb");
    let activeId = null;

    function release(event) {
    if (activeId === null || (event && event.pointerId !== activeId)) return;
    activeId = null;
    if (kind === "move") {
        input.moveX = 0;
        input.moveY = 0;
    } else {
        input.lookX = 0;
        input.lookY = 0;
    }
    thumb.style.transform = "translate(0px, 0px)";
    }

    function update(event) {
    if (event.pointerId !== activeId) return;
    const rect = element.getBoundingClientRect();
    const max = rect.width * .31;
    let dx = event.clientX - (rect.left + rect.width / 2);
    let dy = event.clientY - (rect.top + rect.height / 2);
    const length = Math.hypot(dx, dy);
    if (length > max) {
        dx = dx / length * max;
        dy = dy / length * max;
    }
    const nx = dx / max;
    const ny = dy / max;
    thumb.style.transform = "translate(" + dx + "px, " + dy + "px)";
    if (kind === "move") {
        input.moveX = nx;
        input.moveY = -ny;
    } else {
        input.lookX = nx;
        input.lookY = -ny;
    }
    }

    element.addEventListener("pointerdown", function (event) {
    if (activeId !== null) return;
    event.preventDefault();
    activeId = event.pointerId;
    element.setPointerCapture(activeId);
    update(event);
    });
    element.addEventListener("pointermove", update);
    element.addEventListener("pointerup", release);
    element.addEventListener("pointercancel", release);
    element.addEventListener("lostpointercapture", release);
}

setupStick("moveStick", "move");
setupStick("lookStick", "look");
resize();
window.addEventListener("resize", resize, { passive: true });

sceneHost.addEventListener("pointerdown", function (event) {
    if (event.button !== undefined && event.button !== 0) return;
    dragPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    sceneHost.setPointerCapture(event.pointerId);
    sceneHost.classList.add("dragging");
});

sceneHost.addEventListener("pointermove", function (event) {
    if (!dragPointer || event.pointerId !== dragPointer.id) return;
    const dx = event.clientX - dragPointer.x;
    const dy = event.clientY - dragPointer.y;
    dragPointer.x = event.clientX;
    dragPointer.y = event.clientY;
    yaw -= dx * .0042;
    pitch = THREE.MathUtils.clamp(pitch - dy * .0037, -1.35, 1.35);
    setCameraAngles();
});

function endDrag(event) {
    if (!dragPointer || (event && event.pointerId !== dragPointer.id)) return;
    dragPointer = null;
    sceneHost.classList.remove("dragging");
}
sceneHost.addEventListener("pointerup", endDrag);
sceneHost.addEventListener("pointercancel", endDrag);
sceneHost.addEventListener("lostpointercapture", endDrag);

sceneHost.addEventListener("wheel", function (event) {
    event.preventDefault();
   
   if (event.deltaY < 0) {
    keys.add("c");
   } else keys.add("v");

   deleteWheelSetEvents = true
}, { passive: false });

window.addEventListener("keydown", function (event) {
    if (event.target instanceof HTMLElement && event.target.closest("button, input, select, textarea")) return;
    const key = event.key.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d", "c", "v"].includes(key)) {
    event.preventDefault();
    keys.add(key);
    }
});
window.addEventListener("keyup", function (event) { keys.delete(event.key.toLowerCase()); });
window.addEventListener("blur", function () { keys.clear(); });

function updateMovement(delta) {
    let moveX = input.moveX;
    let moveY = input.moveY;
    if (keys.has("arrowleft") || keys.has("a")) moveX -= 1;
    if (keys.has("arrowright") || keys.has("d")) moveX += 1;
    if (keys.has("arrowup") || keys.has("w")) moveY += 1;
    if (keys.has("arrowdown") || keys.has("s")) moveY -= 1;

    yaw -= input.lookX * delta * 1.8;
    pitch = THREE.MathUtils.clamp(pitch + input.lookY * delta * 1.35, -1.35, 1.35);
    setCameraAngles();
    if (!modelRoot) return;

    const heightInput = Number(keys.has("v")) - Number(keys.has("c"));
    if (heightInput !== 0) {
    updateHeight(heightInput, delta)
    }
    if (deleteWheelSetEvents) {
        keys.delete("c");
        keys.delete("v");
        deleteWheelSetEvents = false
    }

    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < .0001) {
    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    } else {
    forward.normalize();
    }
    right.crossVectors(forward, up).normalize();
    desiredStep.set(0, 0, 0)
    .addScaledVector(forward, moveY)
    .addScaledVector(right, moveX);
    if (desiredStep.lengthSq() < .0001) return;
    desiredStep.normalize().multiplyScalar(delta * 3.0);
    camera.position.x += desiredStep.x;
    camera.position.z += desiredStep.z;
    if (modelBounds) {
    const pad = 5;
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, modelBounds.min.x - pad, modelBounds.max.x + pad);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, modelBounds.min.z - pad, modelBounds.max.z + pad);
    }
}

function updateHeight(heightInput, delta){
    const maxHeight = modelBounds.max.y + 5
    camera.position.y = THREE.MathUtils.clamp(camera.position.y + heightInput * delta * 2.4, .25, maxHeight);
}
function animate(now) {
    const delta = Math.min((now - lastFrame) / 1000, .05);
    lastFrame = now;
    updateMovement(delta);
    renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

const localModels = new Map();
for (const model of MODELS) addOption(model.id, model.label);
updateModelCount();

modelSelect.addEventListener("change", function () {
    const selectedId = modelSelect.value;
    const published = MODELS.find(function (model) { return model.id === selectedId; });
    if (published) {
    loadPublished(published);
    return;
    }
    const file = localModels.get(selectedId);
    if (file) loadLocalFile(file, selectedId);
});

function openFilePicker() { fileInput.click(); }
document.getElementById("uploadButton").addEventListener("click", openFilePicker);
document.getElementById("emptyUploadButton").addEventListener("click", openFilePicker);
document.getElementById("retryButton").addEventListener("click", function () {
    const model = MODELS.find(function (item) { return item.id === modelSelect.value; }) || MODELS[0];
    loadPublished(model);
});
document.getElementById("resetButton").addEventListener("click", resetView);
fileInput.addEventListener("change", function () {
    const file = fileInput.files && fileInput.files[0];
    if (file) loadLocalFile(file);
    fileInput.value = "";
});

loadPublished(MODELS[0]);