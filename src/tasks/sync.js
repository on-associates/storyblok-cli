const pSeries = require('p-series')
const chalk = require('chalk')
const StoryblokClient = require('storyblok-js-client')
const { capitalize, findByProperty } = require('../utils')

const SyncSpaces = {
  targetComponents: [],
  sourceComponents: [],

  init (options) {
    console.log(chalk.green('✓') + ' Loading options')
    this.sourceSpaceId = options.source
    this.targetSpaceId = options.target
    this.client = new StoryblokClient({
      oauthToken: options.token
    }, options.api)
  },

  async syncStories () {
    console.log(chalk.green('✓') + ' Syncing stories...')
    var targetFolders = await this.client.getAll(`spaces/${this.targetSpaceId}/stories`, {
      folder_only: 1,
      sort_by: 'slug:asc'
    })

    var folderMapping = {}

    for (let i = 0; i < targetFolders.length; i++) {
      var folder = targetFolders[i]
      folderMapping[folder.full_slug] = folder.id
    }

    var all = await this.client.getAll(`spaces/${this.sourceSpaceId}/stories`, {
      story_only: 1
    })

    for (let i = 0; i < all.length; i++) {
      console.log(chalk.green('✓') + ' Starting update ' + all[i].full_slug)

      var storyResult = await this.client.get('spaces/' + this.sourceSpaceId + '/stories/' + all[i].id)
      var sourceStory = storyResult.data.story
      var slugs = sourceStory.full_slug.split('/')
      var folderId = 0

      if (slugs.length > 1) {
        slugs.pop()
        var folderSlug = slugs.join('/')

        if (folderMapping[folderSlug]) {
          folderId = folderMapping[folderSlug]
        } else {
          console.error(chalk.red('X') + 'The folder does not exist ' + folderSlug)
          continue
        }
      }

      sourceStory.parent_id = folderId

      try {
        var existingStory = await this.client.get('spaces/' + this.targetSpaceId + '/stories', { with_slug: all[i].full_slug })
        var payload = {
          story: sourceStory,
          force_update: '1'
        }
        if (sourceStory.published) {
          payload.publish = '1'
        }

        if (existingStory.data.stories.length === 1) {
          await this.client.put('spaces/' + this.targetSpaceId + '/stories/' + existingStory.data.stories[0].id, payload)
          console.log(chalk.green('✓') + ' Updated ' + existingStory.data.stories[0].full_slug)
        } else {
          await this.client.post('spaces/' + this.targetSpaceId + '/stories', payload)
          console.log(chalk.green('✓') + ' Created ' + sourceStory.full_slug)
        }
      } catch (e) {
        console.log(e)
      }
    }

    return Promise.resolve(all)
  },

  async syncFolders () {
    console.log(chalk.green('✓') + ' Syncing folders...')
    const sourceFolders = await this.client.getAll(`spaces/${this.sourceSpaceId}/stories`, {
      folder_only: 1,
      sort_by: 'slug:asc'
    })
    const syncedFolders = {}

    for (var i = 0; i < sourceFolders.length; i++) {
      const folder = sourceFolders[i]
      const folderId = folder.id
      delete folder.id
      delete folder.created_at

      if (folder.parent_id) {
        // Parent child resolving
        if (!syncedFolders[folderId]) {
          const folderSlug = folder.full_slug.split('/')
          const parentFolderSlug = folderSlug.splice(0, folderSlug.length - 1).join('/')

          const existingFolders = await this.client.get(`spaces/${this.targetSpaceId}/stories`, {
            with_slug: parentFolderSlug
          })

          if (existingFolders.data.stories.length) {
            folder.parent_id = existingFolders.data.stories[0].id
          } else {
            folder.parent_id = 0
          }
        } else {
          folder.parent_id = syncedFolders[folderId]
        }
      }

      try {
        const newFolder = await this.client.post(`spaces/${this.targetSpaceId}/stories`, {
          story: folder
        })

        syncedFolders[folderId] = newFolder.data.story.id
        console.log(`Folder ${newFolder.data.story.name} created`)
      } catch (e) {
        console.log(`Folder ${folder.name} already exists`)
      }
    }
  },

  async syncRoles () {
    console.log(chalk.green('✓') + ' Syncing roles...')
    const existingFolders = await this.client.getAll(`spaces/${this.targetSpaceId}/stories`, {
      folder_only: 1,
      sort_by: 'slug:asc'
    })

    const roles = await this.client.get(`spaces/${this.sourceSpaceId}/space_roles`)
    const existingRoles = await this.client.get(`spaces/${this.targetSpaceId}/space_roles`)

    for (var i = 0; i < roles.data.space_roles.length; i++) {
      const spaceRole = roles.data.space_roles[i]
      delete spaceRole.id
      delete spaceRole.created_at

      spaceRole.allowed_paths = []

      spaceRole.resolved_allowed_paths.forEach((path) => {
        const folders = existingFolders.filter((story) => {
          return story.full_slug + '/' === path
        })

        if (folders.length) {
          spaceRole.allowed_paths.push(folders[0].id)
        }
      })

      const existingRole = existingRoles.data.space_roles.filter((role) => {
        return role.role === spaceRole.role
      })
      if (existingRole.length) {
        await this.client.put(`spaces/${this.targetSpaceId}/space_roles/${existingRole[0].id}`, {
          space_role: spaceRole
        })
      } else {
        await this.client.post(`spaces/${this.targetSpaceId}/space_roles`, {
          space_role: spaceRole
        })
      }
      console.log(chalk.green('✓') + ` Role ${spaceRole.role} synced`)
    }
  },

  async syncComponents () {
    let sourcePresets = []
    let componentsGroups = []
    let targetComponentGroups = []

    console.log(`${chalk.green('-')} Syncing components...`)

    try {
      // load data from target and source spaces
      this.targetComponents = await this.getComponents(this.targetSpaceId)
      this.sourceComponents = await this.getComponents(this.sourceSpaceId)

      sourcePresets = await this.getPresets(this.sourceSpaceId)
      componentsGroups = await this.getComponentGroups(this.sourceSpaceId)
      targetComponentGroups = await this.getComponentGroups(this.targetSpaceId)

      console.log(
        `${chalk.blue('-')} In source space #${this.sourceSpaceId}, found: `
      )
      console.log(`  - ${sourcePresets.length} presets`)
      console.log(`  - ${componentsGroups.length} groups`)
    } catch (e) {
      console.error('An error ocurred when load data to sync: ' + e.message)

      return Promise.reject(e)
    }

    for (var i = 0; i < this.sourceComponents.data.components.length; i++) {
      console.log()

      const component = this.sourceComponents.data.components[i]
      console.log(chalk.blue('-') + ` Processing component ${component.name}`)

      const componentPresets = this.getComponentPresets(
        sourcePresets,
        component
      )

      delete component.id
      delete component.created_at

      const sourceGroupUuid = component.component_group_uuid

      // if the component belongs to a group
      if (sourceGroupUuid) {
        const sourceGroup = findByProperty(
          componentsGroups,
          'uuid',
          sourceGroupUuid
        )

        const targetGroupData = findByProperty(
          targetComponentGroups,
          'name',
          sourceGroup.name
        )

        // check if the component group have already been created in target space
        if (targetGroupData.name) {
          console.log(
            `${chalk.yellow('-')} Component group ${targetGroupData.name} already exists`
          )
          component.component_group_uuid = targetGroupData.uuid
        } else {
          // the group don't exists in target space, creating one
          const sourceGroupName = sourceGroup.name

          try {
            console.log(
              `${chalk.blue('-')} Creating the ${sourceGroupName} component group`
            )
            const groupCreated = await this.createComponentGroup(
              this.targetSpaceId,
              sourceGroupName
            )

            component.component_group_uuid = groupCreated.uuid

            targetComponentGroups.push(groupCreated)

            console.log(
              `${chalk.green('✓')} Component group ${sourceGroupName} synced`
            )
          } catch (e) {
            console.error(
              `${chalk.red('X')} Component Group ${sourceGroupName} creating failed: ${e.message}`
            )
          }
        }
      }

      // Create new component on target space
      try {
        const componentCreated = await this.createComponent(
          this.targetSpaceId, component
        )

        console.log(chalk.green('✓') + ` Component ${component.name} synced`)

        if (componentPresets.length) {
          await this.createPresets(componentPresets, componentCreated.id)
        }
      } catch (e) {
        if (e.response.status === 422) {
          console.log(
            `${chalk.yellow('-')} Component ${component.name} already exists, updating it...`
          )

          const componentTarget = this.getTargetComponent(component.name)
          await this.updateComponent(
            this.targetSpaceId,
            componentTarget.id,
            component,
            componentTarget
          )
          console.log(chalk.green('✓') + ` Component ${component.name} synced`)

          const presetsToSave = this.filterPresetsFromTargetComponent(
            componentPresets || [],
            componentTarget.all_presets || []
          )

          if (presetsToSave.length) {
            await this.createPresets(presetsToSave, componentTarget.id)
            return
          }

          console.log(chalk.green('✓') + ' Presets were already in sync')
        } else {
          console.error(chalk.red('X') + ` Component ${component.name} sync failed: ${e.message}`)
        }
      }
    }
  },

  createComponent (spaceId, componentData) {
    return this
      .client
      .post(`spaces/${spaceId}/components`, {
        component: componentData
      })
      .then(response => {
        const component = response.data.component || {}

        return component
      })
      .catch(error => Promise.reject(error))
  },

  updateComponent (spaceId, componentId, sourceComponentData, targetComponentData) {
    const payload = {
      component: this.mergeComponents(sourceComponentData, targetComponentData)
    }
    return this
      .client
      .put(`spaces/${spaceId}/components/${componentId}`, payload)
  },

  mergeComponents (sourceComponent, targetComponent) {
    const data = {
      ...sourceComponent,
      ...targetComponent
    }

    // handle specifically
    data.schema = this.mergeComponentSchema(
      sourceComponent.schema,
      targetComponent.schema
    )

    return data
  },

  mergeComponentSchema (sourceSchema, targetSchema) {
    return Object.keys(sourceSchema).reduce((acc, key) => {
      // handle blocks separately
      if (key === 'blocks') {
        const sourceSchemaItem = sourceSchema[key]
        const targetSchemaItem = targetSchema[key]

        acc[key] = {
          ...sourceSchemaItem,
          // prevent missing refence to group in whitelist
          component_group_whitelist: targetSchemaItem.component_group_whitelist || []
        }
        return acc
      }

      acc[key] = sourceSchema[key]

      return acc
    }, {})
  },

  getComponents (spaceId) {
    console.log(
      `${chalk.green('-')} Load components from space #${spaceId}`
    )

    return this.client.get(`spaces/${spaceId}/components`)
  },

  createComponentGroup (spaceId, componentGroupName) {
    return this
      .client
      .post(`spaces/${spaceId}/component_groups`, {
        component_group: {
          name: componentGroupName
        }
      })
      .then(response => response.data.component_group || {})
      .catch(error => Promise.reject(error))
  },

  getComponentGroups (spaceId) {
    console.log(
      `${chalk.green('-')} Load component groups from space #${spaceId}`
    )

    return this.client
      .get(`spaces/${spaceId}/component_groups`)
      .then(response => response.data.component_groups || [])
      .catch(err => Promise.reject(err))
  },

  getTargetComponent (name) {
    const comps = this.targetComponents.data.components.filter((comp) => {
      return comp.name === name
    })

    return comps[0]
  },

  filterPresetsFromTargetComponent (presets, targetPresets) {
    console.log(chalk.blue('-') + ' Checking target presets to sync')
    const targetPresetsNames = targetPresets.map(preset => {
      return preset.name.toLowerCase()
    })

    return presets.filter(preset => {
      return !targetPresetsNames.includes(preset.name.toLowerCase())
    })
  },

  async getPresets (spaceId) {
    console.log(`${chalk.green('-')} Load presets from space #${spaceId}`)

    try {
      const response = await this.client.get(
        `spaces/${spaceId}/presets`
      )

      return response.data.presets || []
    } catch (e) {
      console.error('An error ocurred when load presets ' + e.message)

      return Promise.reject(e)
    }
  },

  getComponentPresets (sourcePresets = [], component = {}) {
    console.log(`${chalk.green('-')} Get presets from component ${component.name}`)

    return sourcePresets.filter(preset => {
      return preset.component_id === component.id
    })
  },

  async createPresets (presets = [], componentId) {
    const presetsSize = presets.length
    console.log(`${chalk.green('-')} Syncing ${presetsSize} presets to space #${this.targetSpaceId}`)

    try {
      for (let i = 0; i < presetsSize; i++) {
        const presetData = presets[i]

        await this.client.post(`spaces/${this.targetSpaceId}/presets`, {
          preset: {
            name: presetData.name,
            component_id: componentId,
            space_id: this.targetSpaceId,
            preset: presetData.preset
          }
        })
      }

      console.log(`${chalk.green('✓')} ${presetsSize} presets sync in space (#${this.targetSpaceId})`)
    } catch (e) {
      console.error('An error ocurred when save the presets' + e.message)

      return Promise.reject(e)
    }
  }
}

/**
 * @method sync
 * @param  {Array} types
 * @param  {*} options      { token: String, source: Number, target: Number, api: String }
 * @return {Promise}
 */
const sync = (types, options) => {
  SyncSpaces.init(options)

  const tasks = types.map(_type => {
    const command = `sync${capitalize(_type)}`

    return () => SyncSpaces[command]()
  })

  return pSeries(tasks)
}

module.exports = sync
