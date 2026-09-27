import * as ecs from '@8thwall/ecs'

ecs.registerComponent({
  name: 'example-component',
  schema: {
    targetName: ecs.string,
  },
  schemaDefaults: {
    targetName: '',
  },
  add: () => {
    console.log('Component attached.')
  },
  stateMachine: ({world, eid, schemaAttribute}) => {
    ecs.defineState('default')
      .initial()
      .listen(world.events.globalId, ecs.events.REALITY_IMAGE_LOST, (event) => {
        const {targetName} = schemaAttribute.get(eid)
        const data = event.data as {name: string}

        if (data.name !== targetName) return

        // Undo the built-in hide-on-lost behavior
        ecs.Hidden.remove(world, eid)
      })
  },
})