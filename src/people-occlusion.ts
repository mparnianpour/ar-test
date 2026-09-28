import * as ecs from '@8thwall/ecs'

// =================================================================================================
// people-occlusion
//
// Hides virtual content behind real people who are standing or sitting in front of it.
//
// Attach it (from Studio: New Component -> people-occlusion) to every entity that should go behind
// people, e.g. the Plane on the wall. Several times a second, the part of the camera image around
// those entities is run through a person-segmentation model. Wherever a person is found, an
// invisible depth mask is drawn before the scene, so the virtual content there is not drawn and
// the real camera image (the person) shows through.
//
// - Assumes people are IN FRONT of the occluded content. True for anything hung on the walls.
// - Only the area around the occluded entities is analysed. That keeps people big enough for the
//   model to find them from across the room (on the whole frame it misses them), and keeps it fast.
// - The model and its runtime live in src/assets/mediapipe, so nothing is loaded from Google.
//   If they fail to load, AR keeps working without occlusion (see the console).
// =================================================================================================

const ASSET_DIR = 'assets/mediapipe/'
const MODEL_FILE = 'selfie_segmenter.tflite'
const MASK_SIZE = 256

type Rect = {u0: number, v0: number, u1: number, v1: number}  // screen UV, v measured from the top
type Source = {image: CanvasImageSource, width: number, height: number}

type OccluderParams = {
  camera: any
  targets: any[]
  source: Source | null
  now: number
  intervalMs: number
  roiScale: number
  threshold: number
  showMask: boolean
}

// Full-screen quad in clip space. z is just inside the near plane, so its depth beats everything.
const VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, -0.9999, 1.0);
}`

const FRAGMENT_SHADER = `
uniform sampler2D uMask;
uniform vec4 uRect;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec2 s = vec2(vUv.x, 1.0 - vUv.y);
  vec2 m = (s - uRect.xy) / (uRect.zw - uRect.xy);
  if (m.x < 0.0 || m.x > 1.0 || m.y < 0.0 || m.y > 1.0) discard;
  if (texture2D(uMask, m).r < uThreshold) discard;
  gl_FragColor = vec4(1.0, 0.0, 0.6, 1.0);  // only visible when showMask is on
}`

const isShown = (obj: any) => {
  for (let o = obj; o; o = o.parent) {
    if (!o.visible) {
      return false
    }
  }
  return true
}

// Engine-independent core: owns the segmenter, the mask texture and the occluder mesh.
class PeopleOccluder {
  status: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'

  private THREE: any
  private renderer: any
  private scene: any
  private segmenter: any = null
  private mesh: any
  private material: any
  private maskData: Uint8Array
  private maskTexture: any
  private cropCanvas: HTMLCanvasElement
  private cropCtx: CanvasRenderingContext2D
  private lastRun = -Infinity
  private lastTimestamp = 0
  private box: any
  private corner: any

  constructor(THREE: any, renderer: any, scene: any) {
    this.THREE = THREE
    this.renderer = renderer
    this.scene = scene
    this.box = new THREE.Box3()
    this.corner = new THREE.Vector3()

    this.maskData = new Uint8Array(MASK_SIZE * MASK_SIZE * 4)
    this.maskTexture = new THREE.DataTexture(
      this.maskData, MASK_SIZE, MASK_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType
    )
    this.maskTexture.magFilter = THREE.LinearFilter
    this.maskTexture.minFilter = THREE.LinearFilter
    this.maskTexture.generateMipmaps = false
    this.maskTexture.needsUpdate = true

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMask: {value: this.maskTexture},
        uRect: {value: new THREE.Vector4(0, 0, 1, 1)},
        uThreshold: {value: 0.4},
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      // Depth only. Depth writes need the depth test enabled, hence ALWAYS instead of off.
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      transparent: false,
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    this.mesh.name = 'people-occlusion-mask'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1e6  // drawn before every other opaque and transparent object
    this.mesh.visible = false
    this.scene.add(this.mesh)

    this.cropCanvas = document.createElement('canvas')
    this.cropCanvas.width = MASK_SIZE
    this.cropCanvas.height = MASK_SIZE
    this.cropCtx = this.cropCanvas.getContext('2d')
  }

  async load(assetBase: string) {
    if (this.status !== 'idle') {
      return
    }
    this.status = 'loading'
    try {
      const vision = await import(/* webpackIgnore: true */ `${assetBase}vision_bundle.js`)
      const fileset = await vision.FilesetResolver.forVisionTasks(`${assetBase}wasm`)
      const create = (delegate: 'GPU' | 'CPU') => vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {modelAssetPath: `${assetBase}${MODEL_FILE}`, delegate},
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      })
      try {
        this.segmenter = await create('GPU')
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[people-occlusion] GPU segmentation unavailable, using CPU', e)
        this.segmenter = await create('CPU')
      }
      this.status = 'ready'
      // eslint-disable-next-line no-console
      console.log('[people-occlusion] person segmentation ready')
    } catch (e) {
      this.status = 'failed'
      // eslint-disable-next-line no-console
      console.warn('[people-occlusion] could not load person segmentation; occlusion is off', e)
    }
  }

  // Screen-space box (UV, v from top) around all targets, or null if none is on screen.
  private targetsRect(camera: any, targets: any[]): Rect | null {
    let u0 = Infinity
    let v0 = Infinity
    let u1 = -Infinity
    let v1 = -Infinity
    let any = false
    for (const obj of targets) {
      if (!obj || !isShown(obj)) {
        continue
      }
      this.box.setFromObject(obj)
      if (this.box.isEmpty()) {
        continue
      }
      const {min, max} = this.box
      let behind = 0
      for (let i = 0; i < 8; i++) {
        this.corner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
        this.corner.applyMatrix4(camera.matrixWorldInverse)
        if (this.corner.z > -camera.near) {
          behind++
          continue
        }
        this.corner.applyMatrix4(camera.projectionMatrix)
        u0 = Math.min(u0, (this.corner.x + 1) / 2)
        u1 = Math.max(u1, (this.corner.x + 1) / 2)
        v0 = Math.min(v0, (1 - this.corner.y) / 2)
        v1 = Math.max(v1, (1 - this.corner.y) / 2)
      }
      if (behind === 8) {
        continue
      }
      if (behind > 0) {
        // Partly behind the camera: its projection is unreliable, so analyse the whole view.
        return {u0: 0, v0: 0, u1: 1, v1: 1}
      }
      any = true
    }
    if (!any) {
      return null
    }
    u0 = Math.max(0, u0)
    v0 = Math.max(0, v0)
    u1 = Math.min(1, u1)
    v1 = Math.min(1, v1)
    return u1 > u0 && v1 > v0 ? {u0, v0, u1, v1} : null
  }

  update(p: OccluderParams) {
    this.material.colorWrite = p.showMask
    const rect = this.targetsRect(p.camera, p.targets)
    if (!rect || this.status !== 'ready' || !p.source || !p.source.width || !p.source.height) {
      this.mesh.visible = false
      return
    }
    if (p.now - this.lastRun < p.intervalMs) {
      return  // keep showing the last mask
    }
    this.lastRun = p.now

    // The camera image fills the canvas without distortion, centred and cropped ("cover"), exactly
    // like XR8.GlTextureRenderer.fillTextureViewport. Map the screen box into camera pixels.
    const canvas = this.renderer.domElement
    const cw = canvas.width || canvas.clientWidth
    const ch = canvas.height || canvas.clientHeight
    const {width: vw, height: vh} = p.source
    const scale = Math.max(cw / vw, ch / vh)
    const offX = (cw - vw * scale) / 2
    const offY = (ch - vh * scale) / 2

    const cx = ((rect.u0 + rect.u1) / 2) * cw
    const cy = ((rect.v0 + rect.v1) / 2) * ch
    const sideCanvas = Math.max((rect.u1 - rect.u0) * cw, (rect.v1 - rect.v0) * ch) * p.roiScale
    let side = Math.min(sideCanvas / scale, vw, vh)
    side = Math.max(side, Math.min(vw, vh) * 0.1)
    const sx = Math.min(Math.max((cx - offX) / scale - side / 2, 0), vw - side)
    const sy = Math.min(Math.max((cy - offY) / scale - side / 2, 0), vh - side)

    this.cropCtx.drawImage(p.source.image, sx, sy, side, side, 0, 0, MASK_SIZE, MASK_SIZE)

    const timestamp = Math.max(Math.round(p.now), this.lastTimestamp + 1)
    this.lastTimestamp = timestamp
    let ok = false
    try {
      this.segmenter.segmentForVideo(this.cropCanvas, timestamp, (result: any) => {
        const masks = result.confidenceMasks
        if (!masks || !masks.length) {
          return
        }
        const conf: Float32Array = masks[masks.length - 1].getAsFloat32Array()
        const n = Math.min(conf.length, MASK_SIZE * MASK_SIZE)
        for (let i = 0; i < n; i++) {
          this.maskData[i * 4] = conf[i] * 255
        }
        ok = true
      })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[people-occlusion] segmentation failed for this frame', e)
    }
    if (!ok) {
      this.mesh.visible = false
      return
    }
    this.maskTexture.needsUpdate = true
    this.material.uniforms.uThreshold.value = p.threshold
    this.material.uniforms.uRect.value.set(
      (sx * scale + offX) / cw,
      (sy * scale + offY) / ch,
      ((sx + side) * scale + offX) / cw,
      ((sy + side) * scale + offY) / ch
    )
    this.mesh.visible = true
  }

  dispose() {
    this.scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.maskTexture.dispose()
    try {
      this.segmenter?.close()
    } catch (e) {
      // ignore
    }
  }
}

// -------------------------------------------------------------------------------------------------
// ECS glue: one shared occluder per world, fed by every entity that has the component.
// -------------------------------------------------------------------------------------------------

// The engine's camera feed: a hidden <video> that 8th Wall adds next to the canvas.
const findCameraVideo = (): HTMLVideoElement | null => {
  const videos = Array.from(document.querySelectorAll('video'))
  return videos.find(v => v.srcObject && v.videoWidth > 0 && v.readyState >= 2) || null
}

type Shared = {occluder: PeopleOccluder, eids: Set<ecs.Eid>, lastFrame: number}
const shared = new Map<ecs.World, Shared>()

const PeopleOcclusion = ecs.registerComponent({
  name: 'people-occlusion',
  schema: {
    // Person confidence (0..1) needed to hide content. Lower = the cut-out grows a little.
    threshold: ecs.f32,
    // Size of the analysed area relative to the content's size on screen.
    roiScale: ecs.f32,
    // Segmentation runs per second. Lower it if the phone gets slow or hot.
    maxFps: ecs.f32,
    // Paint detected people magenta, to check what the model sees.
    showMask: ecs.boolean,
  },
  schemaDefaults: {
    threshold: 0.4,
    roiScale: 1.8,
    maxFps: 15,
    showMask: false,
  },

  add: (world, component) => {
    let s = shared.get(world)
    if (!s) {
      const {THREE} = window as any
      const occluder = new PeopleOccluder(THREE, world.three.renderer, world.three.scene)
      s = {occluder, eids: new Set(), lastFrame: -1}
      shared.set(world, s)
      occluder.load(new URL(ASSET_DIR, document.baseURI).href)
    }
    s.eids.add(component.eid)
  },

  tick: (world, component) => {
    const s = shared.get(world)
    if (!s || s.lastFrame === world.time.elapsed) {
      return  // already updated this frame by another entity
    }
    s.lastFrame = world.time.elapsed
    const {threshold, roiScale, maxFps, showMask} = component.schema
    const video = findCameraVideo()
    s.occluder.update({
      camera: world.three.activeCamera,
      targets: Array.from(s.eids, eid => world.three.entityToObject.get(eid)),
      source: video ? {image: video, width: video.videoWidth, height: video.videoHeight} : null,
      now: performance.now(),
      intervalMs: 1000 / Math.max(1, maxFps),
      roiScale: Math.max(1, roiScale),
      threshold,
      showMask,
    })
  },

  remove: (world, component) => {
    const s = shared.get(world)
    if (!s) {
      return
    }
    s.eids.delete(component.eid)
    if (s.eids.size === 0) {
      s.occluder.dispose()
      shared.delete(world)
    }
  },
})

export {PeopleOcclusion, PeopleOccluder}
