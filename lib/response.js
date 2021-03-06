const {compact, empty, prettyJson} = require('lib/util')

function response (logger, config) {
  function redirect (res, url) {
    res.writeHead(301, {Location: url})
    res.end('')
  }

  function notFound (res) {
    res.writeHead(404, {'Content-Type': 'application/json'})
    res.end('{}')
  }

  function wrapData (data) {
    return {data}
  }

  function jsonResponse (req, res, data, options = {}) {
    const defaultStatus = empty(compact(data)) ? 404 : 200
    const status = options.status || defaultStatus
    const headers = {'Content-Type': 'application/json'}
    const elapsed = req.responseTime && req.responseTime()
    if (elapsed) headers['X-Response-Time'] = elapsed
    if (req.requestId) headers['X-Request-ID'] = req.requestId
    res.writeHead(status, headers)
    res.end(prettyJson(data))
    logger.debug(`jsonResponse ${req.method} ${req.url} status=${status} elapsed=${elapsed} requestId=${req.requestId}`)
  }

  function formatError (status, error) {
    if (error instanceof Error) {
      return {status, errors: [error.message]}
    } else {
      return error
    }
  }

  // The 422 (Unprocessable Entity) status code means the server understands the content type
  // of the request entity (hence a 415 (Unsupported Media Type) status code is inappropriate),
  // and the syntax of the request entity is correct (thus a 400 (Bad Request) status code is inappropriate)
  // but was unable to process the contained instructions. For example, this error condition
  // may occur if an XML request body contains well-formed (i.e., syntactically correct),
  // but semantically erroneous, XML instructions.
  function errorResponse (req, res, error, message) {
    const status = error.status || 500
    const headers = {'Content-Type': 'application/json'}
    const elapsed = req.responseTime && req.responseTime()
    if (elapsed) headers['X-Response-Time'] = elapsed
    if (req.requestId) headers['X-Request-ID'] = req.requestId
    const logLevel = (status === 500 ? 'error' : 'info')
    logger.log(logLevel, `errorResponse ${req.method} ${req.url} status=${status} elapsed=${elapsed} requestId=${req.requestId} message=${message}`, error)
    res.writeHead(status, headers)
    res.end(prettyJson(formatError(status, error)))
    if (status === 500 && process.env.BUGSNAG_API_KEY) {
      require('bugsnag').notify(error)
    }
  }

  return {
    redirect,
    wrapData,
    notFound,
    jsonResponse,
    errorResponse
  }
}

module.exports = response
