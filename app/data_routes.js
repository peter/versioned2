const {empty, compact, json, parseJson, pick, zipObj, rename, property, concat, getIn, keys, keyValues, merge} = require('lib/util')
const _models = require('app/models/models')
const spaces = require('app/models/spaces')
const modelController = require('lib/model_controller')
const config = require('app/config')
const {logger} = config.modules
const {notFound} = config.modules.response
const swaggerHandler = require('app/controllers/swagger').index
const {wrapData, jsonResponse} = config.modules.response
const {idType} = require('lib/model_meta')
const {requestSchema, responseSchema} = require('lib/model_access')
const {LIST_PARAMETERS} = require('app/model_routes')
const DEFAULTS = require('lib/model_spec').DEFAULTS
const graphql = require('app/graphql')

const PARAMS = {
  model: ['model', 'coll']
}

async function getModels (space) {
  return spaces.getApi(space, _models.model)
}

async function makeController (space, model) {
  const options = {scope: 'spaceId'}
  const api = await _models.getApi(space, model)
  const getApi = () => api
  return modelController(api.model, getApi, config.modules.response, options)
}

function withParams (path, options = {}) {
  return keys(PARAMS).reduce((result, param) => {
    return options[param] ? result.replace(`:${param}`, getIn(options, PARAMS[param])) : result
  }, path)
}

function apiKeyParameter () {
  return {
    name: 'apiKey',
    description: 'The API Key provides read-only data access for clients - mobile/web apps etc',
    in: 'query',
    required: false,
    schema: {
      type: 'string'
    }
  }
}

function spaceIdParameter () {
  return {
    name: 'spaceId',
    in: 'path',
    required: true,
    schema: {
      type: 'string'
    }
  }
}

function idParameter (model) {
  return {
    name: 'id',
    in: 'path',
    required: true,
    schema: {
      type: (model ? idType(model.model) : 'string')
    }
  }
}

function parameters (model, endpoint) {
  const readParameters = [apiKeyParameter()]
  const listParameters = concat(LIST_PARAMETERS, [spaceIdParameter()])
  const getParameters = concat(listParameters, idParameter(model))
  return {
    list: concat(readParameters, listParameters),
    get: concat(readParameters, getParameters),
    create: listParameters,
    update: getParameters,
    delete: getParameters
  }[endpoint]
}

function listPath (prefix, options) {
  return withParams(`/${prefix}/:spaceId/:model`, options)
}

function getPath (prefix, options) {
  return withParams(`${listPath(prefix)}/:id`, options)
}

function swaggerPath (prefix, options) {
  return withParams(`/${prefix}/:spaceId/swagger.json`, options)
}

function dbStatsPath (prefix, options) {
  return withParams(`/${prefix}/:spaceId/dbStats.json`, options)
}

function importPath (prefix, options) {
  return withParams(`/${prefix}/:spaceId/import/:model`, options)
}

function graphQLPath (prefix, options) {
  return withParams(`/${prefix}/:spaceId/graphql`, options)
}

function dataHandler (coll, endpoint) {
  async function _dataHandler (req, res) {
    const query = {
      spaceId: req.params.spaceId,
      coll
    }
    const models = await getModels(req.space)
    const model = await models.get(query)
    if (model) {
      const controller = await makeController(req.space, model)
      controller[endpoint](req, res)
    } else {
      notFound(res)
    }
  }
  _dataHandler.endpointName = `data.${coll}.${endpoint}`
  return _dataHandler
}

function swaggerRoute (prefix, options) {
  return {
    summary: 'Swagger JSON description of the data API for a particular space',
    tags: ['data'],
    method: 'get',
    path: swaggerPath(prefix),
    handler: swaggerHandler,
    parameters: [spaceIdParameter()]
  }
}

async function dbStatsHandler (req, res) {
  const models = await getModels(req.space)
  const modelSpecs = await models.list({spaceId: req.space.id})
  const colls = modelSpecs.map(model => getIn(model, 'model.coll'))
  const types = modelSpecs.map(property('coll'))
  const collsToTypes = zipObj(colls, types)
  const spaceMongo = await spaces.getMongo(req.space)
  const stats = await spaceMongo.dbStats({colls})
  const statsByType = rename(stats, collsToTypes)
  jsonResponse(req, res, wrapData(statsByType))
}

async function importHandler (req, res) {
  const models = await getModels(req.space)
  const modelsQuery = {spaceId: req.params.spaceId, coll: req.params.model}
  const model = await models.get(modelsQuery, {allowMissing: false})
  const controller = await makeController(req.space, model)
  const results = []
  const counts = {success: 0, error: 0}
  const createOptions = {import: true}
  for (let doc of (req.params.docs || [])) {
    try {
      const result = await controller._create(req, doc, {createOptions})
      results.push({result})
      counts.success += 1
    } catch (error) {
      results.push({error})
      counts.error += 1
    }
  }
  const status = (counts.error > 0 ? 422 : 200)
  jsonResponse(req, res, {results, counts}, {status})
}

async function graphQLHandler (req, res) {
  const graphQLOptions = pick(req.params, ['operationName', 'variables'])
  const options = {graphQLOptions, makeController, req, space: req.space}
  const result = await graphql.query(req.params.query, options)
  // TODO: how do we distinguish a 500 error from a 422 error?
  const status = result.errors ? 422 : 200
  if (result.errors) logger.debug('graphQLHandler errors', result.errors)
  if (result.errors && empty(compact(parseJson(json(result.errors))))) {
    // NOTE: Workaround for JSON.stringify(result.errors) yielding an empty object
    result.errors = result.errors.map(e => e.message)
  }
  jsonResponse(req, res, result, {status})
}

function importRoute (prefix, options) {
  return {
    summary: 'Import/create up to a 100 documents per request',
    tags: ['data'],
    method: 'post',
    path: importPath(prefix),
    handler: importHandler,
    parameters: [
      spaceIdParameter(),
      {
        name: 'model',
        in: 'path',
        description: 'Key of model to import',
        required: true,
        schema: {
          type: 'string'
        }
      },
      {
        name: 'docs',
        in: 'body',
        description: 'Array of documents to import',
        required: true,
        schema: {
          type: 'array',
          maxItems: 100,
          items: {type: 'object'}
        }
      }
    ]
  }
}

function graphQLRoute (prefix, options) {
  return {
    summary: 'Make a graphQL query to get/list data in a space',
    tags: ['data'],
    method: 'post',
    path: graphQLPath(prefix),
    handler: graphQLHandler,
    allowApiKey: true,
    parameters: [
      spaceIdParameter(),
      merge(apiKeyParameter(), {required: true}),
      {
        name: 'query',
        in: 'body',
        description: 'GraphQL query',
        required: true,
        schema: {
          type: 'string'
        }
      },
      {
        name: 'operationName',
        in: 'body',
        required: false,
        schema: {
          type: 'string'
        }
      },
      {
        name: 'variables',
        in: 'body',
        required: false,
        schema: {
          type: 'object'
        }
      }
    ]
  }
}

function dbStatsRoute (prefix, options) {
  return {
    summary: 'Database stats (number of documents per collection) for the space',
    tags: ['data'],
    method: 'get',
    path: dbStatsPath(prefix),
    handler: dbStatsHandler,
    allowApiKey: true,
    parameters: [spaceIdParameter()]
  }
}

const ROUTES = {
  list: {
    method: 'get',
    path: listPath
  },
  get: {
    method: 'get',
    path: getPath
  },
  create: {
    method: 'post',
    path: listPath
  },
  update: {
    method: 'put',
    path: getPath
  },
  delete: {
    method: 'delete',
    path: getPath
  }
}

async function modelRoutes (prefix, options = {}) {
  const modelCallbacks = require('lib/model_callbacks')(logger)
  const result = []
  const apiRoutes = keys(getIn(options, 'api.model.routes', DEFAULTS.routes))
  const routes = keyValues(ROUTES).filter(r => apiRoutes.includes(r[0]))
  for (let [endpoint, route] of routes) {
    const summary = options.model ? `${endpoint} ${options.model.coll} data` : `${endpoint} data`
    const handler = options.handler ? options.handler(endpoint) : dataHandler(options.model.coll, endpoint)
    route = merge(route, {
      action: endpoint,
      tags: [`${options.model.coll} data`],
      path: route.path(prefix, options),
      handler,
      allowApiKey: true,
      summary,
      parameters: parameters(options.model, endpoint),
      requestSchema: requestSchema(getIn(options, ['api', 'model']), endpoint),
      responseSchema: responseSchema(getIn(options, ['api', 'model']), endpoint)
    })
    if (options.api) {
      route = await modelCallbacks(options.api, route, 'after', 'routeCreate', options)
    }
    result.push(route)
  }
  return result
}

async function routes (prefix, options = {}) {
  let result = [swaggerRoute(prefix, options), dbStatsRoute(prefix, options), importRoute(prefix, options), graphQLRoute(prefix, options)]
  if (options.space) {
    const models = await getModels(options.space)
    let spaceModels = await models.list({spaceId: options.space.id})
    if (options.models) spaceModels = spaceModels.concat(options.models)
    for (let model of spaceModels) {
      const api = await _models.getApi(options.space, model)
      const routes = await modelRoutes(prefix, merge(options, {model, api}))
      result = result.concat(routes)
    }
  }
  return result
}

module.exports = routes
