import * as ecs from '@8thwall/ecs'

// =================================================================================================
// scan-display
//
// Put this on the museum2.glb entity to choose how the scan itself shows up in AR:
//   'ghost'    semi-transparent overlay. Use it while checking alignment against the real room.
//   'occluder' invisible, but it hides virtual things behind real walls/furniture.
//   'visible'  the scan as-is.
//   'hidden'   not drawn at all.
// =================================================================================================

type Mode = 'ghost' | 'occluder' | 'visible' | 'hidden'

const MODES: Mode[] = ['ghost', 'occluder', 'visible', 'hidden']

const listeners = new Map<ecs.Eid, () => void>()

const applyMode = (world: ecs.World, eid: ecs.Eid, mode: Mode, opacity: number) => {
  const root = world.three.entityToObject.get(eid)
  if (!root) {
    return false
  }
  let meshes = 0
  root.traverse((obj: any) => {
    if (!obj.isMesh) {
      return
    }
    meshes += 1
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    materials.forEach((m: any) => {
      if (!m) {
        return
      }
      // Remember the original settings once, so switching modes is reversible.
      if (!m.userData.scanDisplayOriginal) {
        m.userData.scanDisplayOriginal = {
          transparent: m.transparent,
          opacity: m.opacity,
          colorWrite: m.colorWrite,
          depthWrite: m.depthWrite,
        }
      }
      const o = m.userData.scanDisplayOriginal
      m.transparent = mode === 'ghost' ? true : o.transparent
      m.opacity = mode === 'ghost' ? opacity : o.opacity
      m.colorWrite = mode !== 'occluder' && o.colorWrite
      m.depthWrite = mode === 'ghost' ? false : o.depthWrite
      m.needsUpdate = true
    })
    obj.visible = mode !== 'hidden'
    // Occluders must write depth before the artwork is drawn.
    obj.renderOrder = mode === 'occluder' ? -1 : 0
  })
  return meshes > 0
}

const ScanDisplay = ecs.registerComponent({
  name: 'scan-display',
  schema: {
    mode: ecs.string,
    opacity: ecs.f32,
  },
  schemaDefaults: {
    mode: 'ghost',
    opacity: 0.45,
  },
  data: {
    applied: ecs.string,
  },
  add: (world, component) => {
    const {eid} = component
    const apply = () => {
      const {mode, opacity} = component.schemaAttribute.get(eid)
      const m = (MODES.includes(mode as Mode) ? mode : 'ghost') as Mode
      if (applyMode(world, eid, m, opacity)) {
        component.dataAttribute.set(eid, {applied: `${m}:${opacity}`})
      }
    }
    listeners.set(eid, apply)
    world.events.addListener(eid, ecs.events.GLTF_MODEL_LOADED, apply)
    apply()
  },
  remove: (world, component) => {
    const apply = listeners.get(component.eid)
    if (apply) {
      world.events.removeListener(component.eid, ecs.events.GLTF_MODEL_LOADED, apply)
      listeners.delete(component.eid)
    }
  },
  tick: (world, component) => {
    // Re-apply if the mode/opacity was changed at runtime (e.g. from another component).
    const {mode, opacity} = component.schema
    const m = (MODES.includes(mode as Mode) ? mode : 'ghost') as Mode
    const key = `${m}:${opacity}`
    if (component.data.applied && component.data.applied !== key) {
      if (applyMode(world, component.eid, m, opacity)) {
        component.data.applied = key
      }
    }
  },
})

export {ScanDisplay}
