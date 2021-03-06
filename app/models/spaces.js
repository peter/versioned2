const config = require('app/config')
const {isArray, map, getIn, property, merge, notEmpty, empty} = require('lib/util')
const modelApi = require('lib/model_api')
const {logger, mongo} = require('app/config').modules
const MongoClient = require('mongodb').MongoClient
const mongoModule = require('lib/mongo')
const accounts = require('app/models/accounts')
const {validationError} = require('lib/errors')
const {findAvailableKey} = require('lib/unique_key')
const search = require('lib/search')
const webhook = require('app/webhook')
const {languageToCode} = require('lib/language_codes')

const coll = 'spaces'
const API_KEY_LENGTH = 16
const DB_KEY_LENGTH = 8 // 16^8 ~ 1 billion
const DB_KEY_PREFIX = 's'

const mongoCache = {}

async function getMongo (space) {
  if (space.mongodbUrl) {
    if (mongoCache[space.mongodbUrl]) return mongoCache[space.mongodbUrl]
    const mongo = mongoModule(space.mongodbUrl)
    await mongo.connect()
    mongoCache[space.mongodbUrl] = mongo
    return mongo
  } else {
    return config.modules.mongo
  }
}

async function getApi (space, model) {
  if (getIn(space, 'mongodbUrl')) {
    const dedicatedMongo = await getMongo(space)
    return modelApi(model, dedicatedMongo, logger)
  } else {
    return modelApi(model, mongo, logger)
  }
}

async function setDbKey (doc, options) {
  const dbKey = await findAvailableKey(mongo, coll, 'dbKey', {length: DB_KEY_LENGTH, prefix: DB_KEY_PREFIX})
  return merge(doc, {dbKey})
}

async function setDefaultAlgoliaIndexName (doc, options) {
  if (notEmpty(doc.algoliaApiKey) && empty(doc.algoliaIndexName) && doc.dbKey) {
    const algoliaIndexName = ['versioned', doc.dbKey].join('-')
    return merge(doc, {algoliaIndexName})
  }
}

async function setApiKey (doc, options) {
  const apiKey = await findAvailableKey(mongo, coll, 'apiKey', {length: API_KEY_LENGTH})
  return merge(doc, {apiKey})
}

function validateAlgoliaFields (doc, options) {
  if (doc.mongodbUrl && (empty(doc.algoliaApplicationId) || empty(doc.algoliaApiKey)) && config.NODE_ENV !== 'test') {
    throw validationError(options.model, doc, `dedicated database requires dedicated search, i.e. if you specify MongoDB URL you must also specify Algolia Application ID and API Key`, 'mongodbUrl')
  }
}

async function validateWebhookUrl (doc, options) {
  if (doc.webhookUrl && doc.webhookUrl !== getIn(options, 'existingDoc.webhookUrl')) {
    try {
      await webhook.invoke(doc.webhookUrl, {}, {catchError: false})
    } catch (error) {
      let message = `Error when doing HTTP post with an empty JSON body (${error.message})`
      // const status = getIn(error, 'response.status')
      // if (status) message = message + ` ${status}`
      throw validationError(options.model, doc, message, 'webhookUrl')
    }
  }
}

function validateLanguages (doc, options) {
  if (!isArray(doc.languages)) return
  for (let language of doc.languages) {
    if (!languageToCode(language)) {
      throw validationError(options.model, doc, `Language ${language} not supported`, 'languages')
    }
  }
}

async function validateMongodbUrl (doc, options) {
  if (doc.mongodbUrl) {
    try {
      await MongoClient.connect(doc.mongodbUrl)
    } catch (err) {
      throw validationError(options.model, doc, `could not connect to '${doc.mongodbUrl}'`, 'mongodbUrl')
    }
  }
  return doc
}

async function checkAccess (doc, options) {
  if (doc.accountId) {
    const account = await accounts.get(doc.accountId)
    if (!account) throw validationError(options.model, doc, `could not find account ${doc.accountId}`, 'accountId')
    const adminIds = account.users.filter(u => u.role === 'admin').map(property('id'))
    const userId = getIn(options, 'user.id')
    if (!adminIds.includes(userId)) {
      throw validationError(options.model, doc, `to create or update a space you need to have the administrator role in the ${account.name} account`)
    }
  }
  return doc
}

async function setupSearch (doc, options) {
  await search(config, {space: doc}).setup()
}

async function deleteSearch (doc, options) {
  await search(config, {space: doc}).deleteIndex()
}

function addAlgoliaFields (data, options) {
  function addFields (doc) {
    const _search = search(config, {space: doc})
    return merge(doc, {
      algoliaSharedApiKey: _search.sharedApiKey,
      algoliaSharedIndexName: _search.sharedIndexName
    })
  }
  return data ? map(data, addFields) : data
}

const model = {
  coll,
  schema: {
    type: 'object',
    properties: {
      name: {type: 'string'},
      accountId: {
        type: 'string',
        'x-meta': {
          update: false,
          index: true,
          relationship: {
            toTypes: ['accounts'],
            toField: 'spaces',
            name: 'account',
            type: 'many-to-one'
          }
        }
      },
      models: {
        type: 'array',
        items: {type: 'string'},
        'x-meta': {
          writable: false,
          relationship: {
            toTypes: ['models'],
            toField: 'spaceId',
            type: 'one-to-many'
          }
        }
      },
      dbKey: {
        type: 'string',
        pattern: `^${DB_KEY_PREFIX}[a-z0-9_]+$`,
        maxLength: (DB_KEY_LENGTH + DB_KEY_PREFIX.length),
        'x-meta': {writable: false, unique: {index: true}}
      },
      apiKey: {
        type: 'string',
        pattern: `^[a-z0-9_]+$`,
        maxLength: API_KEY_LENGTH,
        'x-meta': {writable: false, unique: {index: true}}
      },
      mongodbUrl: {type: 'string'},
      algoliaApplicationId: {type: 'string', pattern: '^[a-zA-Z0-9]{10}$'},
      algoliaApiKey: {type: 'string', pattern: '^[a-zA-Z0-9]{32}$'},
      algoliaIndexName: {type: 'string', pattern: '^(?:\s|[.a-zA-Z0-9_-])+$', maxLength: 256},
      algoliaSharedApiKey: {type: 'string', 'x-meta': {writable: false}},
      algoliaSharedIndexName: {type: 'string', 'x-meta': {writable: false}},
      cloudinaryUrl: {type: 'string'},
      cloudinaryPreset: {type: 'string'},
      languages: {
        type: 'array',
        items: {type: 'string'}
      },
      webhookUrl: {type: 'string'}
    },
    required: ['name', 'accountId', 'dbKey'],
    additionalProperties: false
  },
  callbacks: {
    list: {
      after: [addAlgoliaFields]
    },
    get: {
      after: [addAlgoliaFields]
    },
    create: {
      beforeValidation: [setDbKey, setApiKey]
    },
    save: {
      beforeValidation: [checkAccess, validateMongodbUrl, validateAlgoliaFields, validateWebhookUrl, setDefaultAlgoliaIndexName, validateLanguages],
      afterSave: [setupSearch]
    },
    delete: {
      before: [deleteSearch]
    }
  },
  indexes: [
    {
      keys: {name: 1, accountId: 1},
      options: {unique: true}
    }
  ]
}

async function deleteSearchIndexes (_mongo = mongo) {
  const spacesList = await modelApi(model, _mongo, logger).list()
  for (let space of spacesList) {
    logger.info(`spaces.deleteSearchIndexes - delete search index for space ${space.name}...`)
    await search(config, {space}).deleteIndex()
  }
}

module.exports = Object.assign(modelApi(model, mongo, logger), {
  getMongo,
  getApi,
  deleteSearchIndexes
})
