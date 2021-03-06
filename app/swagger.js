const swaggerUtil = require('lib/swagger_util')
const config = require('app/config')
const spaces = require('app/models/spaces')

async function swagger (options = {}) {
  const routesModule = require('app/routes')
  const space = options.spaceId && (await spaces.get(options.spaceId))
  const allRoutes = await routesModule.getRoutes({space})
  const routes = allRoutes.filter(route => {
    return !(route.tags || []).includes('system') && !route.superUser && route.swagger !== false
  })
  const title = space ? `${config.TITLE} - space: ${space.name}` : config.TITLE
  const swaggerOptions = {
    title,
    description: config.DESCRIPTION,
    version: routesModule.VERSION,
    basePath: undefined
  }
  return swaggerUtil.swagger(routes, swaggerOptions)
}

module.exports = swagger
