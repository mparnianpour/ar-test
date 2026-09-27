import * as ecs from '@8thwall/ecs'

// =================================================================================================
// scene-anchor
//
// Places the scan (museum2.glb) and everything under it in the real room. The image target is only
// used to work out where the scan belongs; the entity itself lives in WORLD space, so SLAM holds it
// in place after the target leaves the camera.
//
// Scene setup in Studio:
//   Camera           XR World, "Disable World Tracking" OFF
//   Image Target     keep the Image Target entity (so the target is loaded), but leave it EMPTY
//   Venue            <- attach `scene-anchor` here. Must sit at the scene root, NOT under the image
//     museum2.glb       target. Position/rotation/scale set in the editor are overwritten at runtime.
//     your artwork      Place children in the scan's own coordinates (meters, the GLB's axes).
// =================================================================================================

// -------------------------------------------------------------------------------------------------
// WHERE EACH PRINTED IMAGE SITS INSIDE THE SCAN. Paste the snippet from the Target Placer page here.
//
//   name         the image target's name, exactly as in Studio's Image Targets panel
//   longestSide  length of the image's LONGEST edge (the full uploaded image, not the crop), in the
//                scan's units. If the print is visible in the scan, use the length measured IN THE
//                SCAN (the Placer's corner pick does this): that also absorbs any scale error in the
//                scan. If the print isn't in the scan, use its tape-measured length in meters.
//   position     centre of the image, in the GLB's coordinates (meters)
//   rotation     quaternion [x, y, z, w] of the image's frame inside the GLB:
//                +X = towards the image's right edge, +Y = towards its top edge,
//                +Z = out of the image's face, towards the viewer
//
// Add one entry per target for hand-off between several targets.
// -------------------------------------------------------------------------------------------------
type AnchorTarget = {
  name: string
  longestSide: number
  position: [number, number, number]
  rotation: [number, number, number, number]
}

const ANCHOR_TARGETS: AnchorTarget[] = [
  {
    // Target 20260927_131028: your photo of the big print on the back wall. It covers the
    // right-centre part of the print (1.47 x 1.05 m in the scan). Found by matching the target photo
    // against the scan's texture (310 matched features); orientation taken from a plane fitted
    // across the whole print.
    name: '20260927_131028',
    longestSide: 1.4707,
    position: [-1.6251, 0.151, -4.1298],
    rotation: [0.01547, -0.02276, -0.00212, 0.99962],
  },
]

// -------------------------------------------------------------------------------------------------
// Small quaternion/vector helpers on plain {x, y, z(, w)} objects.
// -------------------------------------------------------------------------------------------------
type V3 = {x: number, y: number, z: number}
type Q = {x: number, y: number, z: number, w: number}
type Pose = {p: V3, q: Q}

const qNorm = (q: Q): Q => {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1
  return {x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l}
}

const qMul = (a: Q, b: Q): Q => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
})

const qConj = (q: Q): Q => ({x: -q.x, y: -q.y, z: -q.z, w: q.w})

const qDot = (a: Q, b: Q) => a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w

const qRotate = (q: Q, v: V3): V3 => {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y
  const iy = q.w * v.y + q.z * v.x - q.x * v.z
  const iz = q.w * v.z + q.x * v.y - q.y * v.x
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  }
}

// Keep only the rotation about the world's vertical axis (swing-twist decomposition around +Y).
const qYawOnly = (q: Q): Q => {
  const l = Math.hypot(q.y, q.w)
  return l < 1e-6 ? {x: 0, y: 0, z: 0, w: 1} : {x: 0, y: q.y / l, z: 0, w: q.w / l}
}

const qSlerp = (a: Q, b0: Q, t: number): Q => {
  let b = b0
  let cos = qDot(a, b)
  if (cos < 0) {
    b = {x: -b.x, y: -b.y, z: -b.z, w: -b.w}
    cos = -cos
  }
  if (cos > 0.9995) {
    return qNorm({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      w: a.w + (b.w - a.w) * t,
    })
  }
  const theta = Math.acos(cos)
  const sin = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / sin
  const wb = Math.sin(t * theta) / sin
  return {x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb, z: a.z * wa + b.z * wb, w: a.w * wa + b.w * wb}
}

const qAngleDeg = (a: Q, b: Q) => (2 * Math.acos(Math.min(1, Math.abs(qDot(a, b)))) * 180) / Math.PI

const vLerp = (a: V3, b: V3, t: number): V3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
})

const vDist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// Where the scan's origin must be in the world so that `target`'s spot in the scan lands exactly
// on the detected image. k = scene units per meter.
//   world = T(pImage) * R * S(k) * T(-pTargetInScan),  R = qImage * inverse(qTargetInScan)
const scanPoseFromImage = (target: AnchorTarget, pImage: V3, qImage: Q, k: number,
  upright: boolean): Pose => {
  const [px, py, pz] = target.position
  const [rx, ry, rz, rw] = target.rotation
  let q = qMul(qNorm(qImage), qConj(qNorm({x: rx, y: ry, z: rz, w: rw})))
  if (upright) {
    q = qYawOnly(q)
  }
  const off = qRotate(q, {x: px * k, y: py * k, z: pz * k})
  return {p: {x: pImage.x - off.x, y: pImage.y - off.y, z: pImage.z - off.z}, q: qNorm(q)}
}

// Averages several pose estimates (quaternions are sign-aligned to the first one).
type SampleBuffer = {n: number, p: V3, q: Q, k: number, ref: Q | null}
const emptyBuffer = (): SampleBuffer => ({n: 0, p: {x: 0, y: 0, z: 0}, q: {x: 0, y: 0, z: 0, w: 0}, k: 0, ref: null})

const addSample = (b: SampleBuffer, pose: Pose, k: number) => {
  let {q} = pose
  if (!b.ref) {
    b.ref = q
  } else if (qDot(b.ref, q) < 0) {
    q = {x: -q.x, y: -q.y, z: -q.z, w: -q.w}
  }
  b.n += 1
  b.p = {x: b.p.x + pose.p.x, y: b.p.y + pose.p.y, z: b.p.z + pose.p.z}
  b.q = {x: b.q.x + q.x, y: b.q.y + q.y, z: b.q.z + q.z, w: b.q.w + q.w}
  b.k += k
}

const bufferMean = (b: SampleBuffer): {pose: Pose, k: number} => ({
  pose: {p: {x: b.p.x / b.n, y: b.p.y / b.n, z: b.p.z / b.n}, q: qNorm(b.q)},
  k: b.k / b.n,
})

// -------------------------------------------------------------------------------------------------
// Per-entity runtime state (kept out of the ECS data schema because it holds objects).
// -------------------------------------------------------------------------------------------------
type ImageEventData = {
  name: string
  position: V3
  rotation: Q
  scale: number
}

type AnchorState = {
  anchored: boolean
  k: number
  goal: Pose | null
  current: Pose | null
  settled: boolean  // current == goal and already written to the entity
  lockBuffer: SampleBuffer
  jumpBuffer: SampleBuffer
  tracking: Set<string>
  lastTarget: string
  hud: HTMLDivElement | null
  hudText: HTMLDivElement | null
  cleanup: () => void
}

const states = new Map<ecs.Eid, AnchorState>()

const SceneAnchor = ecs.registerComponent({
  name: 'scene-anchor',
  schema: {
    // Frames of image tracking averaged before the scan first appears.
    samplesToLock: ecs.i32,
    // 'refine': while a target is visible, keep nudging the scan onto it (fixes SLAM drift).
    // 'once':   place it once and never move it again (until re-anchored).
    mode: ecs.string,
    // How strongly each tracked frame pulls the scan in 'refine' mode (0..1). Small = steadier.
    refineRate: ecs.f32,
    // If an estimate disagrees by more than this (meters or degrees), treat it as a real jump:
    // average a fresh set of samples first, then glide to it.
    jumpMeters: ecs.f32,
    jumpDegrees: ecs.f32,
    // Seconds the visible scan takes to glide to a new estimate.
    glideSeconds: ecs.f32,
    // Keep the scan level: only use the image's heading, ignore its tilt (needs a Y-up scan).
    keepUpright: ecs.boolean,
    // 'target': derive scene units per meter from the detected image size (works with
    //           Responsive or Absolute camera scale). 'fixed': use fixedScale instead.
    scaleMode: ecs.string,
    fixedScale: ecs.f32,
    hideUntilAnchored: ecs.boolean,
    // Shows a status line and a Re-anchor button over the camera feed.
    debug: ecs.boolean,
  },
  schemaDefaults: {
    samplesToLock: 20,
    mode: 'refine',
    refineRate: 0.05,
    jumpMeters: 0.5,
    jumpDegrees: 8,
    glideSeconds: 0.35,
    keepUpright: true,
    scaleMode: 'target',
    fixedScale: 1,
    hideUntilAnchored: true,
    debug: false,
  },

  add: (world, component) => {
    const {eid} = component
    const cfg = () => component.schemaAttribute.get(eid)
    const targetsByName = new Map(ANCHOR_TARGETS.map(t => [t.name, t]))

    const state: AnchorState = {
      anchored: false,
      k: 1,
      goal: null,
      current: null,
      settled: false,
      lockBuffer: emptyBuffer(),
      jumpBuffer: emptyBuffer(),
      tracking: new Set(),
      lastTarget: '',
      hud: null,
      hudText: null,
      cleanup: () => {},
    }
    states.set(eid, state)

    if (cfg().hideUntilAnchored) {
      ecs.Hidden.set(world, eid)
    }

    const setStatus = (text: string) => {
      if (state.hudText) {
        state.hudText.textContent = text
      }
    }

    const reset = () => {
      state.anchored = false
      state.lockBuffer = emptyBuffer()
      state.jumpBuffer = emptyBuffer()
      setStatus('Re-anchoring: point at a target…')
    }

    const onImage = (e: {data: unknown}) => {
      const data = e.data as ImageEventData
      const target = targetsByName.get(data?.name)
      if (!target) {
        return
      }
      const c = cfg()
      state.tracking.add(target.name)
      state.lastTarget = target.name

      const kSample = c.scaleMode === 'fixed' ? c.fixedScale : data.scale / target.longestSide
      const k = state.anchored ? state.k : kSample
      const estimate = scanPoseFromImage(target, data.position, data.rotation, k, c.keepUpright)

      if (!state.anchored) {
        addSample(state.lockBuffer, estimate, kSample)
        setStatus(`Locking on "${target.name}" ${state.lockBuffer.n}/${c.samplesToLock}`)
        if (state.lockBuffer.n >= Math.max(1, c.samplesToLock)) {
          const mean = bufferMean(state.lockBuffer)
          // Scale is locked from here on; later estimates reuse it.
          state.k = mean.k
          const first = state.current === null
          state.goal = mean.pose
          state.settled = false
          if (first) {
            state.current = mean.pose
          }
          state.anchored = true
          state.lockBuffer = emptyBuffer()
          ecs.Hidden.remove(world, eid)
          setStatus(`Anchored via "${target.name}" (${state.k.toFixed(3)} units/m)`)
          world.events.dispatch(eid, 'scene-anchor-anchored', {target: target.name, scale: state.k})
          // eslint-disable-next-line no-console
          console.log('[scene-anchor] anchored', target.name, 'units per meter', state.k, mean.pose)
        }
        return
      }

      if (c.mode === 'once' || !state.goal) {
        return
      }

      const far = vDist(estimate.p, state.goal.p) > c.jumpMeters * state.k ||
        qAngleDeg(estimate.q, state.goal.q) > c.jumpDegrees
      if (far) {
        // Could be a bad frame or real drift. Only move if it holds for a full set of samples.
        addSample(state.jumpBuffer, estimate, state.k)
        if (state.jumpBuffer.n >= Math.max(1, c.samplesToLock)) {
          state.goal = bufferMean(state.jumpBuffer).pose
          state.settled = false
          state.jumpBuffer = emptyBuffer()
          setStatus(`Corrected via "${target.name}"`)
        }
        return
      }
      state.jumpBuffer = emptyBuffer()
      const r = Math.min(1, Math.max(0, c.refineRate))
      state.goal = {p: vLerp(state.goal.p, estimate.p, r), q: qSlerp(state.goal.q, estimate.q, r)}
      state.settled = false
      setStatus(`Anchored, tracking "${target.name}"`)
    }

    const onLost = (e: {data: unknown}) => {
      const data = e.data as ImageEventData
      if (!targetsByName.has(data?.name)) {
        return
      }
      state.tracking.delete(data.name)
      state.jumpBuffer = emptyBuffer()
      if (!state.anchored) {
        // Not enough frames yet: start over on the next sighting.
        state.lockBuffer = emptyBuffer()
        setStatus('Target lost before locking. Point at a target again.')
      } else if (state.tracking.size === 0) {
        setStatus(`Anchored, holding position (last target "${data.name}")`)
      }
    }

    const onXrStop = () => {
      // The world coordinate frame is gone; the next session must anchor again.
      state.anchored = false
      state.current = null
      state.goal = null
      state.settled = false
      state.lockBuffer = emptyBuffer()
      state.jumpBuffer = emptyBuffer()
      state.tracking.clear()
      if (cfg().hideUntilAnchored) {
        ecs.Hidden.set(world, eid)
      }
    }

    const {globalId} = world.events
    world.events.addListener(globalId, ecs.events.REALITY_IMAGE_FOUND, onImage)
    world.events.addListener(globalId, ecs.events.REALITY_IMAGE_UPDATED, onImage)
    world.events.addListener(globalId, ecs.events.REALITY_IMAGE_LOST, onLost)
    world.events.addListener(globalId, ecs.CameraEvents.XR_CAMERA_STOP, onXrStop)
    // Any component can force a fresh anchor: world.events.dispatch(globalId, 'scene-anchor-reset')
    world.events.addListener(globalId, 'scene-anchor-reset', reset)

    if (cfg().debug && typeof document !== 'undefined') {
      const hud = document.createElement('div')
      hud.style.cssText = 'position:fixed;left:12px;top:12px;z-index:99999;max-width:70vw;' +
        'font:13px/1.35 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.6);' +
        'padding:8px 10px;border-radius:8px;display:flex;gap:10px;align-items:center'
      const text = document.createElement('div')
      text.textContent = 'Point the camera at an image target…'
      const button = document.createElement('button')
      button.textContent = 'Re-anchor'
      button.style.cssText = 'font:inherit;padding:4px 8px;border-radius:6px;border:0'
      button.addEventListener('click', reset)
      hud.append(text, button)
      document.body.appendChild(hud)
      state.hud = hud
      state.hudText = text
    }

    state.cleanup = () => {
      world.events.removeListener(globalId, ecs.events.REALITY_IMAGE_FOUND, onImage)
      world.events.removeListener(globalId, ecs.events.REALITY_IMAGE_UPDATED, onImage)
      world.events.removeListener(globalId, ecs.events.REALITY_IMAGE_LOST, onLost)
      world.events.removeListener(globalId, ecs.CameraEvents.XR_CAMERA_STOP, onXrStop)
      world.events.removeListener(globalId, 'scene-anchor-reset', reset)
      state.hud?.remove()
    }
  },

  tick: (world, component) => {
    const state = states.get(component.eid)
    if (!state || !state.goal || state.settled) {
      // Nothing to do: with no new estimate the entity is left exactly where it is.
      return
    }
    const {glideSeconds} = component.schema
    const dt = Math.min(Math.max(world.time.delta, 0), 100) / 1000
    const t = !state.current || glideSeconds <= 0 ? 1 : 1 - Math.exp(-dt / glideSeconds)
    state.current = state.current
      ? {p: vLerp(state.current.p, state.goal.p, t), q: qSlerp(state.current.q, state.goal.q, t)}
      : state.goal
    if (vDist(state.current.p, state.goal.p) < 1e-5 * state.k && qAngleDeg(state.current.q, state.goal.q) < 1e-4) {
      state.current = state.goal
      state.settled = true
    }

    const {p, q} = state.current
    const {eid} = component
    if (world.getParent(eid)) {
      // Parented: convert to the parent's space so the WORLD pose is what we want.
      world.transform.setWorldTransform(eid, ecs.math.mat4.trs(p, q, {x: state.k, y: state.k, z: state.k}))
    } else {
      world.setPosition(eid, p.x, p.y, p.z)
      world.setQuaternion(eid, q.x, q.y, q.z, q.w)
      world.setScale(eid, state.k, state.k, state.k)
    }
  },

  remove: (world, component) => {
    states.get(component.eid)?.cleanup()
    states.delete(component.eid)
  },
})

export {SceneAnchor, ANCHOR_TARGETS, scanPoseFromImage}
export type {AnchorTarget}
