const assert = require('assert')

const { Transaction } = require('@google-cloud/firestore')
const { detailedDiff } = require('deep-object-diff')

const AsyncEmitter = require('./async-emitter')
const { Data } = require('./data')
const DBError = require('./db-error')
const {
  InvalidOptionsError,
  InvalidParameterError,
  DeletedTwiceError,
  TransactionFailedError,
  WriteAttemptedInReadOnlyTxError,
  ModelTrackedTwiceError,
  ModelAlreadyExistsError,
  TransactionLockTimeoutError
} = require('./errors')
const { Key } = require('./key')
const { Model } = require('./models')
const { sleep, loadOptionDefaults } = require('./utils')

async function getWithArgs (args, callback) {
  if (!args || !(args instanceof Array) || args.length === 0) {
    throw new InvalidParameterError('args', 'must be a non-empty array')
  }
  const [first, ...args1] = args
  if (first && first.prototype instanceof Model) {
    if (args1.length === 1 || args1.length === 2) {
      let handle
      if (args1.length === 2 && args1[1].createIfMissing) {
        handle = first.data(args1[0])
      } else {
        handle = first.key(args1[0])
      }
      return getWithArgs([handle, ...args1.slice(1)], callback)
    } else {
      throw new InvalidParameterError('args',
        'Expecting args to have a tuple of (Model, values, optionalOpt).')
    }
  } else if (first && first instanceof Key) {
    if (args1.length > 1) {
      throw new InvalidParameterError('args',
        'Expecting args to have a tuple of (key, optionalOpt).')
    }
    return callback(first, args1.length === 1 ? args1[0] : undefined)
  } else if (first && first instanceof Array && first.length !== 0) {
    const nonKeys = first.filter(obj => !(obj instanceof Key))
    if (nonKeys.length !== 0) {
      throw new InvalidParameterError('args',
        'Expecting args to have a tuple of ([key], optionalOpt).')
    }
    if (args1.length > 1) {
      throw new InvalidParameterError('args',
        'Expecting args to have a tuple of ([key], optionalOpt).')
    }

    const params = args1.length === 1 ? args1[0] : undefined
    return callback(first, params)
  } else {
    console.log(JSON.stringify(args))
    throw new InvalidParameterError('args',
      'Expecting Model or Key or [Key] as the first argument')
  }
}

/**
 * Context provides a context for interacting with Firestore. It will use a
 * transaction if requested (e.g., we're making changes OR we need consistent
 * reads across multiple items).
 */
class Context {
  /**
   * Options for interacting with Firestore.
   * @typedef {Object} ContextOptions
   * @property {Boolean} [readOnly=false] whether writes are allowed (we could
   *   allow writes outside of tx for performance too, but omitting it for
   *   safety for now)
   * @property {Boolean} [consistentReads=true] whether multiple reads are
   *   guaranteed to be from a consistent snapshot
   * @property {Number} [retries=4] The number of times to retry after the
   *   initial attempt fails.
   * @property {Number} [initialBackoff=500] In milliseconds, delay
   *   after the first attempt fails and before first retry happens.
   * @property {Number} [maxBackoff=10000] In milliseconds, max delay
   *   between retries. Must be larger than 200.
   * @property {Number} [cacheModels=false] Whether to cache models already
   *   retrieved from the database. When off, getting a model with the same key
   *   the second time in the same transaction results in an error. When on,
   *   `get`ting the same key simply returns the cached model. Previous
   *   modifications done to the model are reflected in the returned model. If
   *   the model key was used in some API other than "get", an error will
   *   result.
   */

  /**
   * Returns the default [options]{@link ContextOptions} for a db context.
   */
  get defaultOptions () {
    // istanbul ignore next
    return {
      readOnly: false,
      consistentReads: true,
      initialBackoff: process.env.INDEBUGGER ? 1 : 500,
      maxBackoff: 10000,
      retries: process.env.INDEBUGGER ? 0 : 4, // no retry by default in unit tests for speed
      cacheModels: false
    }
  }

  /**
   * @param {ContextOptions} [options] Options for this context
   */
  constructor (options) {
    this.__eventEmitter = new AsyncEmitter()
    // watch for changes in models we access through this context
    this.__trackedModelsMap = {} // document path -> index of model in the list

    // null elements = deleted
    // undefined elements = fetched but did not exist
    // other elements will be the model we're tracking
    this.__trackedModelsList = []

    // our reference to the db client changes to a transaction ref if needed
    this.__dbCtx = Key.firestoreDB

    const defaults = this.defaultOptions
    this.options = loadOptionDefaults(options, defaults)

    if (this.options.retries < 0) {
      throw new InvalidOptionsError('retries',
        'Retry count must be non-negative')
    }
    if (this.options.initialBackoff < 1) {
      throw new InvalidOptionsError('initialBackoff',
        'Initial back off must be larger than 1ms.')
    }
    if (this.options.maxBackoff < 200) {
      // A transactWrite would take some where between 100~200ms.
      // Max of less than 200 is too aggressive.
      throw new InvalidOptionsError('maxBackoff',
        'Max back off must be larger than 200ms.')
    }
    // read only context use transactions which get a consistent snapshot; to
    // read data inconsistently use another context
    if (!this.options.readOnly) {
      if (!this.options.consistentReads) {
        throw new InvalidOptionsError('consistentReads',
          'read only contexts use a transaction to read data which results ' +
          'in a consistent snapshot; use another context to read data ' +
          'without consistency guarantees (and the locks they may acquire)')
      }
    }
    this.isUsingTx = !this.options.readOnly || this.options.consistentReads
  }

  /**
   * Track models which have been accessed.
   * @param {Model} model A model to track.
   */
  __watchForChangesToSave (model, key) {
    assert.ok(model || key, 'must provide model or key to __watch')
    assert.ok(!(model && key), 'cannot provide both model and key to __watch')
    const keyToUse = model ? model.__key : key
    const path = keyToUse.docRef.path
    const trackedModelIdx = this.__trackedModelsMap[path]
    if (trackedModelIdx !== undefined) {
      const trackedModel = this.__trackedModelsList[trackedModelIdx]
      if (trackedModel) {
        throw new ModelTrackedTwiceError(keyToUse, trackedModel)
      } else {
        // model is undefined if we tried to get() it (without createIfMissing)
        // and it did not yet exist
        this.__trackedModelsList[trackedModelIdx] = model
      }
    } else {
      this.__trackedModelsMap[path] = this.__trackedModelsList.length
      this.__trackedModelsList.push(model)
    }
  }

  async __saveChangedModels () {
    for (const model of this.__trackedModelsList) {
      if (model && (model.isNew || model.__isMutated(!this.options.readOnly))) {
        this.__throwIfWritesNotAllowed(model)
        await model.__write(this)
      }
    }
  }

  /**
   * All events a context may emit.
   *
   * POST_COMMIT: When a transaction is committed. Do clean up,
   *              summery, post process here.
   * TX_FAILED: When a transaction failed permanently (either by failing all
   *            retries, or getting a non-retryable error). Handler has the
   *            signature of (error) => {}.
   */
  static EVENTS = {
    POST_COMMIT: 'postCommit',
    TX_FAILED: 'txFailed'
  }

  addEventHandler (event, handler, name = undefined) {
    if (!Object.values(this.constructor.EVENTS).includes(event)) {
      throw new Error(`Unsupported event ${event}`)
    }
    // istanbul ignore next
    assert(name === undefined || !name.startsWith('_'),
      'Event name must not start with "_"')
    this.__eventIndex = (this.__eventIndex ?? 0) + 1
    this.__eventEmitter.once(event, handler,
      name ?? `_generatedName${this.__eventIndex}`)
  }

  /**
   * Parameters for fetching a model and options to control how a model is
   * fetched from database.
   * @typedef {Object} GetParams
   * @property {Boolean} [createIfMissing=false] If true, a model is returned
   *   regardless of whether the model exists on server. This behavior is the
   *   same as calling create when get(..., { createIfMissing: false }) returns
   *   undefined
   * @property {*} [*] Besides the predefined options, custom key-value pairs
   *   can be added. These values will be made available to the Model's
   *   constructor as an argument.
   */

  /**
   * Get one document.
   *
   * @param {Key} key A key for the item
   * @param {GetParams} params Params for how to get the item
   */
  async __getItem (key, params) {
    const docRef = key.docRef
    const doc = await this.__dbCtx.get(docRef)
      .catch(
        // istanbul ignore next
        e => {
          throw new DBError('get', e)
        })
    return this.__gotItem(key, params, doc)
  }

  /**
   * Gets multiple items in a single call.
   * @param {Array<Key>} keys A list of keys to get.
   * @param {GetParams} params Params used to get items, all items will be
   *   fetched using the same params.
   */
  async __getItems (keys, params) {
    const docRefs = keys.map(key => key.docRef)
    const docs = await this.__dbCtx.getAll(...docRefs)
      .catch(
        // istanbul ignore next
        e => {
          throw new DBError('getAll', e)
        })
    const promises = docs.map((doc, i) => this.__gotItem(keys[i], params, doc))
    return Promise.all(promises)
  }

  async __gotItem (key, params, doc) {
    const isNew = !doc.exists
    if (!params.createIfMissing && isNew) {
      this.__watchForChangesToSave(undefined, key)
      return undefined
    }
    const vals = isNew ? key.vals : (await doc.data())
    if (!isNew) {
      // doc.data() only has data values; vals needs to include key values too
      Object.assign(vals, key.keyComponents)
    }
    const model = new key.Cls(isNew, vals)
    this.__watchForChangesToSave(model)
    return model
  }

  /**
   * Fetches model(s) from database.
   * This method supports 3 different signatures.
   *   get(Cls, keyOrDataValues, params)
   *   get(Key|Data, params)
   *   get([Key|Data], params)
   *
   * Must use a Key when createIfMissing is not true, and Data otherwise.
   *
   * When a list of items is fetched:
   *   Firestore getAll API is called.
   *     Batched fetches are more efficient than calling get with 1 key many
   *     times, since there is less HTTP request overhead.
   *
   * @param {Class} Cls a Model class.
   * @param {String|CompositeID} key Key or keyValues
   * @param {GetParams} [params]
   * @returns Model(s) associated with provided key
   */
  async get (...args) {
    return getWithArgs(args, async (arg, params) => {
      // make sure we have a Key or Data depending on createIfMissing
      params = params || {}
      const argIsArray = arg instanceof Array
      const arr = argIsArray ? arg : [arg]
      for (let i = 0; i < arr.length; i++) {
        if (params.createIfMissing) {
          if (!(arr[i] instanceof Data)) {
            throw new InvalidParameterError('args',
              'must pass a Data to tx.get() when createIfMissing is true')
          }
        } else if (arr[i] instanceof Data) {
          throw new InvalidParameterError('args',
            'must pass a Key to tx.get() when createIfMissing is not true')
        }
      }
      const cachedModels = []
      const keysOrDataToGet = []
      for (const keyOrData of arr) {
        const key = keyOrData.key ?? keyOrData
        const cachedModelIdx = this.__trackedModelsMap[key.docRef.path]
        if (cachedModelIdx !== undefined) {
          const cachedModel = this.__trackedModelsList[cachedModelIdx]
          if (!this.options.cacheModels) {
            throw new ModelTrackedTwiceError(key, cachedModel)
          }
          if (cachedModel === undefined && params.createIfMissing) {
            keysOrDataToGet.push(keyOrData)
          } else {
            cachedModels.push({ key, model: cachedModel })
          }
        } else {
          keysOrDataToGet.push(keyOrData)
        }
      }

      // fetch the data in bulk if more than 1 item was requested
      const fetchedModels = []
      if (keysOrDataToGet.length > 0) {
        if (argIsArray) {
          fetchedModels.push(
            ...await this.__getItems(keysOrDataToGet, params))
        } else {
          // just fetch the one item that was requested
          const key = keysOrDataToGet[0]
          const fut = this.__getItem(key, params)
          const newModel = await fut
          fetchedModels.push(newModel)
        }
      }

      let ret = []
      if (this.options.cacheModels) {
        const findModel = (tableName, id) => {
          for (let index = 0; index < keysOrDataToGet.length; index++) {
            const toGetKeyOrData = keysOrDataToGet[index]
            if (tableName === toGetKeyOrData.Cls.tableName &&
              id === toGetKeyOrData.encodedKey) {
              return fetchedModels[index]
            }
          }

          for (const { key, model } of cachedModels) {
            // istanbul ignore else
            if (tableName === key.Cls.tableName && id === key.encodedKey) {
              // undefined if previous get() found nothing
              // null if previously delete()
              // otherwise a model will be here
              return model
            }
          }
        }
        for (const keyOrData of arr) {
          ret.push(findModel(
            keyOrData.Cls.tableName,
            keyOrData.encodedKey
          ))
        }
      } else {
        // UnorderedModels is really ordered when cacheModels is disabled
        // don't sort to save time
        ret = fetchedModels
      }

      return argIsArray ? ret : ret[0]
    })
  }

  /**
   * Updates an item without reading from DB. Fails if item is not in the db.
   *
   * @param {CompositeID} key The key to update
   * @param {Object} data Updated fields for the item
   */
  async updateWithoutRead (Cls, data) {
    const model = new Cls(false, data, true)
    this.__throwIfWritesNotAllowed(model)
    await model.__write(this)
  }

  __throwIfWritesNotAllowed (data) {
    if (this.options.readOnly) {
      throw new WriteAttemptedInReadOnlyTxError(data)
    }
  }

  /**
   * Creates a model without accessing DB. Write will make sure the item does
   * not exist.
   *
   * @param {Model} Cls A Model class.
   * @param {CompositeID|Object} data A superset of CompositeID of the model,
   *   plus any data for Fields on the Model.
   */
  create (Cls, data) {
    const model = new Cls(true, { ...data })
    this.__watchForChangesToSave(model)
    return model
  }

  /**
   * Sets a model's data. Will overwrite the existing data, if any.
   *
   * @param {Model} Cls A Model class.
   * @param {CompositeID|Object} data A superset of CompositeID of the model,
   *   plus any data for Fields on the Model.
   */
  createOrOverwrite (Cls, data) {
    const model = new Cls(true, { ...data }, false, true)
    this.__watchForChangesToSave(model)
    return model
  }

  /**
   * Deletes model(s) from database.
   *
   * If a model is read from database, but it did not exist when deleting the
   * item, an exception is raised.
   *
   * @param {List<Key|Model>} args Keys and Models
   */
  async delete (...args) {
    this.__throwIfWritesNotAllowed(args[0])
    for (const a of args) {
      let key = a
      if (a instanceof Model) {
        key = a.__key
      }
      if (key instanceof Key) {
        const path = key.docRef.path
        const trackedModelIdx = this.__trackedModelsMap[path]
        if (trackedModelIdx !== undefined) {
          const trackedModel = this.__trackedModelsList[trackedModelIdx]
          if (trackedModel === null) {
            // already asked to delete it
            throw new DeletedTwiceError(key.Cls.tableName, key.encodedKey)
          }
          this.__trackedModelsList[trackedModelIdx] = null
        } else {
          this.__trackedModelsMap[path] = this.__trackedModelsList.length
          this.__trackedModelsList.push(null)
        }
        const ret = this.__dbCtx.delete(key.docRef)
        // depending on whether __dbCtx is a Firestore or Transaction object,
        // we need to wait the result
        if (!(ret instanceof Transaction)) {
          await ret
        }
      } else {
        throw new InvalidParameterError('args', 'Must be models and keys')
      }
    }
  }

  __reset () {
    this.__eventEmitter = new AsyncEmitter()
    this.__trackedModelsList = []
    this.__trackedModelsMap = {}
  }

  static __isRetryable (err) {
    if (err.retryable) {
      return true
    }
    return false
  }

  /** Marks a transaction as read-only. */
  makeReadOnly () {
    this.options.readOnly = true
  }

  /** Enables model cache */
  enableModelCache () {
    this.options.cacheModels = true
  }

  async __tryToRun (func) {
    const ctx = this
    if (ctx.isUsingTx) {
      return await Key.firestoreDB.runTransaction(async tx => {
        ctx.__reset()
        ctx.__dbCtx = tx
        try {
          const ret = await func(ctx)
          await this.__saveChangedModels()
          return ret
        } finally {
          ctx.__dbCtx = Key.firestoreDB
        }
      }, {
        readOnly: ctx.options.readOnly,
        maxAttempts: 1
      })
    } else {
      return await func(ctx)
    }
  }

  /**
   * Runs a closure in transaction.
   * @param {Function} func the closure to run
   * @access private
   */
  async __run (func) {
    if (!(func instanceof Function || typeof func === 'function')) {
      throw new InvalidParameterError('func', 'must be a function / closure')
    }

    let millisBackOff = this.options.initialBackoff
    const maxBackoff = this.options.maxBackoff
    for (let tryCnt = 0; tryCnt <= this.options.retries; tryCnt++) {
      let err
      try {
        err = undefined
        const ret = await this.__tryToRun(func)
        await this.__eventEmitter.emit(this.constructor.EVENTS.POST_COMMIT)
        return ret
      } catch (originalErr) {
        const firestoreError = parseFirestoreError(originalErr)
        err = firestoreError ?? originalErr

        // make sure EVERY error is retryable
        if (!this.constructor.__isRetryable(err)) {
          await this.__eventEmitter.emit(this.constructor.EVENTS.TX_FAILED,
            err)
          throw err
        } else {
          console.log(`ctx commit attempt ${tryCnt} failed with error ${err}`)
        }
      }
      if (tryCnt >= this.options.retries) {
        const retryMsg = `Giving up after ${tryCnt + 1} attempt${tryCnt ? 's' : ''}`
        const newErrorMsg = `${retryMsg}: ${err.message}`
        const errToThrow = new TransactionFailedError(newErrorMsg, err)
        await this.__eventEmitter.emit(this.constructor.EVENTS.TX_FAILED, errToThrow)
        throw errToThrow
      }
      const offset = Math.floor(Math.random() * millisBackOff * 0.2) -
        millisBackOff * 0.1 // +-0.1 backoff as jitter to spread out conflicts
      await sleep(millisBackOff + offset)
      millisBackOff = Math.min(maxBackoff, millisBackOff * 2)
    }
  }

  /**
   * Runs a function in transaction if needed, using specified parameters.
   *
   * If a non-retryable error is thrown while running the transaction, it will
   * be re-raised.
   *
   * @param {ContextOptions} [options]
   * @param {Function} func the closure to run.
   *
   * @example
   * // Can be called in 2 ways:
   * Context.run(async (tx) => {
   *   // Do something
   * })
   *
   * // Or
   * Context.run({ retryCount: 2 }, async (tx) => {
   *   // Do something
   * })
   */
  static async run (...args) {
    const opts = (args.length === 1) ? {} : args[0]
    const func = args[args.length - 1]
    if (args.length <= 0 || args.length > 2) {
      throw new InvalidParameterError('args', 'should be ([options,] func)')
    }
    return new Context(opts).__run(func)
  }

  /**
   * Return before and after snapshots of all relevant models.
   *
   * Does not include deleted models.
   */
  getModelDiffs (filter = () => true) {
    const allBefore = []
    const allAfter = []
    const allDiff = []
    for (const model of this.__trackedModelsList) {
      // istanbul ignore if
      if (!filter(model) || !model) {
        continue
      }
      const before = model.getSnapshot({ initial: true, dbKeys: true })
      const after = model.getSnapshot({ initial: false, dbKeys: true })
      const modelName = model.constructor.tableName
      const key = model.__key.encodedKey
      allBefore.push({ [modelName]: { _id: key, data: before } })
      allAfter.push({ [modelName]: { _id: key, data: after } })
      const diff = detailedDiff(before, after)
      allDiff.push({ [modelName]: { ...key, data: diff } })
    }
    return {
      before: allBefore,
      after: allAfter,
      diff: allDiff
    }
  }
}

function parseFirestoreError (err) {
  // probably a firestore error if it has these fields
  if (err.code && err.details) {
    // error 10 is the "Transaction lock timeout" error; retryable if separate
    // transactions got in each other's way but could succeed if ordered
    // differently (this error happens with pessimistic locking, the default
    // Firestore setting)
    if (err.code === 10 && err.details.indexOf('lock') !== -1) {
      return new TransactionLockTimeoutError(err.message, err)
    }

    // error 6 is if you try to create a model that already exists
    const docInfo = parseFirestoreErrorPath(err)
    if (docInfo) {
      if (err.code === 6) {
        return new ModelAlreadyExistsError(docInfo.table, docInfo.id)
      }
    }
  }
}

function parseFirestoreErrorPath (err) {
  const startIdx = err.message.indexOf('Element {')
  if (startIdx >= 0) {
    const endIdx = err.message.indexOf('}', startIdx)
    if (endIdx > startIdx) {
      try {
        // hacky way to turn the error info into JSON
        const eltStr = err.message.substring(startIdx + 8, endIdx + 1)
          .replace('type', '"type"')
          .replace('name', ', "name"')
        const elt = JSON.parse(eltStr)
        if (elt.type && elt.name) {
          return { table: elt.type, id: elt.name }
        }
        return elt
      } catch { /* no-op */ }
    }
  }
}

module.exports = {
  Context,
  getWithArgs
}
