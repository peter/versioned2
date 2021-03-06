const home = require('app/controllers/home')
const swagger = require('app/controllers/swagger')
const auth = require('app/controllers/auth')
const emails = require('app/controllers/emails')
const sys = require('app/controllers/sys')
const {nil, getIn, concat} = require('lib/util')
const config = require('app/config')
const modelRoutes = require('app/model_routes')(config.modules.response, config.logger)
const getDataRoutes = require('app/data_routes')
const path = require('path')
const router = require('lib/router')
const spaces = require('app/models/spaces')
const accounts = require('app/models/accounts')
const {accessError} = require('lib/errors')
const {VERSION, PREFIX, DATA_PREFIX} = require('app/routes_helper')
const {errorResponse} = config.modules.response

const MODELS_DIR = path.join(__dirname, '/models')

const systemRoutes = [
  {
    tags: ['documentation'],
    summary: 'Home - redirects to documentation page (HTML)',
    method: 'get',
    path: '/',
    handler: home.index,
    requireAuth: false
  },
  {
    tags: ['documentation'],
    summary: 'Swagger JSON description of the API',
    method: 'get',
    path: `${PREFIX}/swagger.json`,
    handler: swagger.index,
    requireAuth: false
  },
  {
    tags: ['auth'],
    summary: 'Log in with email/password and get JWT token',
    method: 'post',
    path: `${PREFIX}/login`,
    handler: auth.login,
    requireAuth: false,
    parameters: [
      {
        name: 'getUser',
        in: 'query',
        description: 'Set to 1 (true) to return user data in the response',
        required: false,
        schema: {
          type: 'boolean'
        }
      }
    ]
  },
  {
    tags: ['auth'],
    summary: 'Verify email for a user with a token from a link delivered in an email',
    method: 'post',
    path: `${PREFIX}/verify-email`,
    handler: auth.verifyEmail,
    requireAuth: false,
    parameters: [
      {
        name: 'email',
        in: 'body',
        description: 'The email address of the user to verify email for',
        required: true,
        schema: {
          type: 'string',
          format: 'email'
        }
      },
      {
        name: 'token',
        in: 'body',
        description: 'The verify email token from the email',
        required: true,
        schema: {
          type: 'string'
        }
      }
    ]
  },
  {
    tags: ['auth'],
    summary: 'Send email with a link to a webpage where you can choose a new password',
    method: 'post',
    path: `${PREFIX}/forgot-password/deliver`,
    handler: auth.forgotPasswordDeliver,
    requireAuth: false,
    parameters: [
      {
        name: 'email',
        in: 'body',
        description: 'The address to deliver forgotten password link to',
        required: true,
        schema: {
          type: 'string',
          format: 'email'
        }
      }
    ]
  },
  {
    tags: ['auth'],
    summary: 'Change password for a user with the token from a forgot password email',
    method: 'post',
    path: `${PREFIX}/forgot-password/change`,
    handler: auth.forgotPasswordChange,
    requireAuth: false,
    parameters: [
      {
        name: 'email',
        in: 'body',
        description: 'The email address of the user to change password for',
        required: true,
        schema: {
          type: 'string',
          format: 'email'
        }
      },
      {
        name: 'token',
        in: 'body',
        description: 'The forgot password token from the email',
        required: true,
        schema: {
          type: 'string'
        }
      },
      {
        name: 'password',
        in: 'body',
        description: 'The new password for the user',
        required: true,
        schema: {
          type: 'string'
        }
      }
    ]
  },
  {
    tags: ['auth'],
    summary: 'Accept invitation to an account',
    method: 'post',
    path: `${PREFIX}/user-invite-accept/:id`,
    handler: auth.userInviteAccept,
    superUser: false,
    parameters: [
      {
        name: 'id',
        in: 'path',
        description: 'The invite ID from the link in the email',
        required: true,
        schema: {
          type: 'string'
        }
      }
    ]
  },
  {
    method: 'get',
    path: `${PREFIX}/email_link/:id/:url`,
    handler: emails.emailLink,
    requireAuth: false,
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: {type: 'string'}
      },
      {
        name: 'url',
        in: 'path',
        required: true,
        schema: {type: 'string'}
      }
    ],
    swagger: false
  },
  {
    tags: ['system'],
    summary: 'Get statistics on database data',
    method: 'get',
    path: `${PREFIX}/sys/${config.SYS_ROUTE_KEY}/dbStats`,
    handler: sys.dbStats,
    requireAuth: false
  },
  {
    tags: ['system'],
    summary: 'Get routes',
    method: 'get',
    path: `${PREFIX}/sys/${config.SYS_ROUTE_KEY}/routes`,
    handler: sys.routes,
    requireAuth: false
  },
  {
    tags: ['system'],
    summary: 'Test error notification',
    method: 'get',
    path: `${PREFIX}/sys/${config.SYS_ROUTE_KEY}/errorTest`,
    handler: sys.errorTest,
    requireAuth: false
  },
  {
    tags: ['system'],
    summary: 'Get Heroku release info',
    method: 'get',
    path: `${PREFIX}/sys/${config.SYS_ROUTE_KEY}/info`,
    handler: sys.info,
    requireAuth: false
  },
  {
    tags: ['system'],
    summary: 'Ping - connects to the database',
    method: 'get',
    path: `${PREFIX}/sys/${config.SYS_ROUTE_KEY}/ping`,
    handler: sys.ping,
    requireAuth: false
  },
  {
    tags: ['system'],
    summary: 'Webhook test endpoint',
    method: 'post',
    path: `${PREFIX}/sys/${config.SYS_ROUTE_KEY}/webhook`,
    handler: sys.webhook,
    requireAuth: false,
    parameters: [
      {
        name: 'delay',
        in: 'query',
        required: false,
        schema: {type: 'integer'}
      }
    ]
  }
]

async function getRoutes (options = {}) {
  const dataRoutes = await getDataRoutes(DATA_PREFIX, options)
  const _modelRoutes = await modelRoutes.requireDir(MODELS_DIR, VERSION)
  return concat(dataRoutes, systemRoutes, _modelRoutes)
}

function parseSpaceId (req) {
  const SPACE_ID_PATTERN = new RegExp(`${DATA_PREFIX}/([a-f0-9]{24})/`)
  const match = req.url.match(SPACE_ID_PATTERN)
  return match && match[1]
}

function checkAccountAccess (req) {
  const {route, user, account} = req
  if (!account) return accessError('No account ID is associated with that endpoint so it requires super user access')
  let message
  const role = getIn((user.accounts || []).find(a => a.id === account.id), 'role')
  const modelName = getIn(route, ['model', 'coll'])
  const writeRequiresAdmin = (getIn(route, 'model.schema.x-meta.writeRequiresAdmin') !== false)
  if (nil(role)) {
    message = `You need to be granted access by an administrator to account ${account.name}`
  } else if (role === 'read' && req.method !== 'GET') {
    message = `You need to be granted write access by an administrator to update content in account ${account.name}`
  } else if (role === 'write' && writeRequiresAdmin) {
    message = `You need to be granted administrator access to update ${modelName}`
  }
  return accessError(message)
}

function checkAccess (req) {
  const {space, route, user} = req
  if (route.requireAuth === false ||
    getIn(route, 'model.schema.x-meta.checkAccess') === false ||
    getIn(user, 'superUser')) {
    return undefined
  }
  const requireSuperUser = route.superUser || (!getIn(route, 'model') && !space && route.superUser !== false)
  if (requireSuperUser) return accessError('You must be super user to access that endpoint')
  const accountScope = req.pathParams.accountId
  return accountScope ? checkAccountAccess(req) : undefined
}

async function lookupRoute (req, res) {
  try {
    const dataSpaceId = parseSpaceId(req)
    let space = dataSpaceId && (await spaces.get(dataSpaceId, {allowMissing: false}))
    if (space) req.space = space
    const routesByMethod = router.groupByMethod(await getRoutes({space}))
    const match = await router.lookupRoute(routesByMethod, req)
    const spaceId = getIn(match, 'params.spaceId')
    if (!dataSpaceId && spaceId) {
      req.space = await spaces.get(spaceId, {allowMissing: false})
    }
    const accountId = getIn(req, 'space.accountId') || getIn(match, 'params.accountId')
    if (accountId) req.account = await accounts.get(accountId, {allowMissing: false})
    return match
  } catch (error) {
    errorResponse(req, res, error)
  }
}

module.exports = {
  VERSION,
  PREFIX,
  getRoutes,
  accessError,
  checkAccess,
  lookupRoute
}
