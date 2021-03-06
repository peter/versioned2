const {isArray, isObject, compact, empty, filter, getIn} = require('lib/util')
const swaggerUtil = require('lib/swagger_util')
const jsonSchema = require('lib/json_schema')
const {coerce} = require('lib/coerce')

const PARAM_TYPES = ['path', 'query', 'body']

function validateParams (req, res, next) {
  for (let paramType of PARAM_TYPES) {
    const swaggerParams = filter(getIn(req, ['route', 'parameters']), p => p.in === paramType) || []
    // NOTE: not all post/put routes have body parameters specified yet so we are permissive with body params if not specified
    if (!(paramType === 'body' && empty(swaggerParams))) {
      const schema = swaggerUtil.parametersToSchema(swaggerParams)
      const paramsKey = `${paramType}Params`
      req[paramsKey] = coerce(schema, req[paramsKey])
      Object.assign(req.params, req[paramsKey])
      const params = req[paramsKey]
      const schemaValue = (isArray(params) || isObject(params)) ? compact(params) : params
      const errors = jsonSchema.validate(schema, schemaValue)
      if (errors) return next(errors)
    }
  }
  next()
}

module.exports = {
  validateParams
}
