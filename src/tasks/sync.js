const chalk = require('chalk')
const StoryblokClient = require('storyblok-js-client')

const SyncSpaces = {
  targetComponents: [],
  sourceComponents: [],

  init (options) {
    console.log(chalk.green('✓') + 'Loading options')
    this.sourceSpaceId = options.source
    this.targetSpaceId = options.target
    this.client = new StoryblokClient({
      oauthToken: options.token
    }, options.api)
  },

  async syncStories () {
    console.log(chalk.green('✓') + 'Syncing stories...')
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
      console.log('starting update ' + all[i].full_slug)

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
          console.log('the folder does not exist ' + folderSlug)
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
          console.log('updated ' + existingStory.data.stories[0].full_slug)
        } else {
          await this.client.post('spaces/' + this.targetSpaceId + '/stories', payload)
          console.log('created ' + sourceStory.full_slug)
        }
      } catch (e) {
        console.log(e)
      }
    }

    return Promise.resolve(all)
  },

  async syncFolders () {
    console.log(chalk.green('✓') + 'Syncing folders...')
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
    console.log(chalk.green('✓') + 'Syncing roles...')
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
      console.log(`Role ${spaceRole.role} synced`)
    }
  },

  async syncComponents () {
    console.log(chalk.green('✓') + 'Syncing components...')
    this.targetComponents = await this.client.get(`spaces/${this.targetSpaceId}/components`)
    this.sourceComponents = await this.client.get(`spaces/${this.sourceSpaceId}/components`)

    for (var i = 0; i < this.sourceComponents.data.components.length; i++) {
      const component = this.sourceComponents.data.components[i]

      delete component.id
      delete component.created_at

      // Create new component on target space
      try {
        await this.client.post(`spaces/${this.targetSpaceId}/components`, {
          component: component
        })
        console.log(`Component ${component.name} synced`)
      } catch (e) {
        if (e.response.status === 422) {
          await this.client.put(`spaces/${this.targetSpaceId}/components/${this.getTargetComponentId(component.name)}`, {
            component: component
          })
          console.log(`Component ${component.name} synced`)
        } else {
          console.log(`Component ${component.name} sync failed`)
        }
      }
    }
  },

  getTargetComponentId (name) {
    const comps = this.targetComponents.data.components.filter((comp) => {
      return comp.name === name
    })

    return comps[0].id
  }
}

/**
 * @method sync
 * @param  {String} command
 * @param  {*} options      { token: String, source: Number, target: Number, api: String }
 * @return {Promise}
 */
const sync = (command, options) => {
  SyncSpaces.init(options)

  return SyncSpaces[command]()
}

module.exports = sync
