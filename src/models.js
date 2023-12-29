const assert = require('assert')

const S = require('@pocketgems/schema')
const stableStringify = require('fast-json-stable-stringify')
const deepcopy = require('rfdc')()

const { Data } = require('./data')
const DBError = require('./db-error')
const {
  InvalidFieldError,
  InvalidModelDeletionError,
  InvalidModelUpdateError,
  InvalidParameterError,
  ModelAlreadyExistsError,
  ModelDeletedTwiceError
} = require('./errors')
const { __Field, SCHEMA_TYPE_TO_FIELD_CLASS_MAP, __CompoundField } = require('./fields')
const { Key } = require('./key')
const {
  validateValue,
  ITEM_SOURCES,
  makeItemString,
  SCHEMA_TYPE_TO_JS_TYPE_MAP,
  sleep
} = require('./utils')

/**
 * The base class for modeling data.
 */
class Model {
  /**
   * Create a representation of a database Item. Should only be used by the
   * library.
   */
  constructor (src, isNew, vals) {
    this.isNew = !!isNew
    if (!ITEM_SOURCES.has(src)) {
      throw new InvalidParameterError('src', 'invalid item source type')
    }
    this.__src = src

    // track whether this item has been written to the db yet
    this.__written = false

    // track whether this item has been marked for deletion
    this.__toBeDeleted = src.isDelete

    // __cached_attrs has a __Field subclass object for each non-key attribute.
    this.__cached_attrs = {}

    // __cached_attrs has a __Field subclass object for each non-key attribute.
    this.__attr_getters = {}

    // Decode _id (stored in DB as string or number, but can be a compound
    // object composed of multiple values of various types)
    const setupKey = (attrName, keySchema, keyOrder, vals) => {
      const attrVal = vals[attrName]
      if (attrVal === undefined) {
        return
      }

      delete vals[attrName]
      const useNumericKey = this.constructor.__useNumericKey(keySchema)
      Object.assign(vals, this.constructor.__decodeCompoundValue(
        keyOrder, attrVal, attrName, useNumericKey))
    }
    setupKey('_id', this.constructor.KEY, this.constructor.__keyOrder, vals)

    // add user-defined fields from FIELDS & key components from KEY
    for (const [name, opts] of Object.entries(this.constructor._attrs)) {
      this.__addField(name, opts, vals)
    }

    for (let field of this.constructor.__compoundFields) {
      if (typeof (field) === 'string') {
        field = [field]
      }
      this.__addCompoundField(field, isNew)
    }

    Object.seal(this)
  }

  static async register (registrator) {
    this.__doOneTimeModelPrep()
    await registrator.registerModel(this)
  }

  /**
   * Hook for finalizing a model before writing to database
   */
  async finalize () {
  }

  __addField (name, opts, vals) {
    let valSpecified = Object.hasOwnProperty.call(vals, name)
    let val = vals[name]
    if (!valSpecified) {
      for (const [encodedName, encodedVal] of Object.entries(vals)) {
        const fieldData = __CompoundField.__decodeValues(encodedName, encodedVal)
        if (Object.hasOwnProperty.call(fieldData, name)) {
          valSpecified = true
          val = fieldData[name]
          break
        }
      }
    }
    const getCachedField = () => {
      if (this.__cached_attrs[name]) {
        return this.__cached_attrs[name]
      }
      const Cls = SCHEMA_TYPE_TO_FIELD_CLASS_MAP[opts.schema.type]
      // can't force validation of undefined values for blind updates because
      //   they are permitted to omit fields
      const field = new Cls({
        name,
        opts,
        val,
        valIsFromDB: !this.isNew,
        valSpecified,
        isForUpdate: this.__src.isUpdate,
        isForDelete: this.__src.isDelete
      })
      Object.seal(field)
      this.__cached_attrs[name] = field
      return field
    }
    this.__attr_getters[name] = getCachedField
    if (this.isNew) {
      getCachedField() // create the field now to trigger validation
    }
    Object.defineProperty(this, name, {
      get: () => {
        const field = getCachedField()
        return field.get()
      },
      set: (val) => {
        const field = getCachedField()
        field.set(val)
      }
    })
  }

  __addCompoundField (fieldNames, isNew) {
    const name = this.constructor.__encodeCompoundFieldName(fieldNames)
    if (this.__attr_getters[name] !== undefined || name === '_id') {
      return
    }
    const fields = fieldNames.map(field => this.__attr_getters[field]())
    const getCachedField = () => {
      if (this.__cached_attrs[name]) {
        return this.__cached_attrs[name]
      }
      const field = new __CompoundField({ name, isNew, fields })
      this.__cached_attrs[name] = field
      return field
    }
    this.__attr_getters[name] = getCachedField
    getCachedField()
    Object.defineProperty(this, name, {
      get: (...args) => {
        const field = getCachedField()
        return field.get()
      },
      set: (val) => {
        const field = getCachedField()
        field.set(val)
      }
    })
  }

  static __getFields () {
    return this.FIELDS
  }

  static __validatedSchema () {
    if (Object.constructor.hasOwnProperty.call(this, '__CACHED_SCHEMA')) {
      return this.__CACHED_SCHEMA
    }

    if (!this.KEY) {
      throw new InvalidFieldError('KEY', 'the partition key is required')
    }
    if (this.KEY.isTodeaSchema || this.KEY.schema) {
      throw new InvalidFieldError('KEY', 'must define key component name(s)')
    }
    if (Object.keys(this.KEY).length === 0) {
      throw new InvalidFieldError('KEY', '/at least one partition key field/')
    }

    // cannot use the names of non-static Model members (only need to list
    // those that are defined by the constructor; those which are on the
    // prototype are enforced automatically)
    const reservedNames = new Set(['isNew'])
    const proto = this.prototype
    const ret = {}
    for (const schema of [this.KEY, this.__getFields()]) {
      for (const [key, val] of Object.entries(schema)) {
        if (ret[key]) {
          throw new InvalidFieldError(
            key, 'property name cannot be used more than once')
        }
        if (reservedNames.has(key)) {
          throw new InvalidFieldError(
            key, 'field name is reserved and may not be used')
        }
        if (key in proto) {
          throw new InvalidFieldError(key, 'shadows a property name')
        }
        ret[key] = val
      }
    }
    this.__CACHED_SCHEMA = S.obj(ret)
    return this.__CACHED_SCHEMA
  }

  static get schema () {
    return this.__validatedSchema()
  }

  static get __keyOrder () {
    if (Object.constructor.hasOwnProperty.call(this, '__CACHED_KEY_ORDER')) {
      return this.__CACHED_KEY_ORDER
    }
    this.__validatedSchema() // use side effect to validate schema
    this.__CACHED_KEY_ORDER = Object.keys(this.KEY).sort()
    return this.__CACHED_KEY_ORDER
  }

  static __validateTableName () {
    const tableName = this.tableName
    try {
      assert.ok(!tableName.endsWith('Model'), 'not include "Model"')
      assert.ok(!tableName.endsWith('Table'), 'not include "Table"')
      assert.ok(tableName.indexOf('_') < 0, 'not include underscores')
      assert.ok(tableName[0].match(/[A-Z]/), 'start with a capitalized letter')
      assert.ok(tableName.match(/[a-zA-Z0-9]*/), 'only use letters or numbers')
    } catch (e) {
      throw new Error(`Bad table name "${tableName}": it must ${e.message}`)
    }
  }

  /**
   * Check that field names don't overlap, etc.
   */
  static __doOneTimeModelPrep () {
    // need to check hasOwnProperty because we don't want to access this
    // property via inheritance (i.e., our parent may have been setup, but
    // the subclass must do its own setup)
    if (Object.hasOwnProperty.call(this, '__setupDone')) {
      return // one-time setup already done
    }
    this.__setupDone = true

    this.__validateTableName()
    // _attrs maps the name of attributes that are visible to users of
    // this model. This is the combination of attributes (keys) defined by KEY
    // and FIELDS.
    this._attrs = {}
    this.__compoundFields = new Set()
    this.__KEY_COMPONENT_NAMES = new Set()
    const partitionKeys = new Set(this.__keyOrder)
    for (const [fieldName, schema] of Object.entries(this.schema.objectSchemas)) {
      const isKey = partitionKeys.has(fieldName)
      const finalFieldOpts = __Field.__validateFieldOptions(
        this.name, isKey, fieldName, schema)
      this._attrs[fieldName] = finalFieldOpts
      if (isKey) {
        this.__KEY_COMPONENT_NAMES.add(fieldName)
      }
    }
  }

  static __useNumericKey (keySchema) {
    const schemas = Object.values(keySchema)
    const isUniqueKey = schemas.length === 1
    if (!isUniqueKey) {
      return false
    }
    let schemaType
    if (typeof (schemas[0]) === 'string') {
      const classSchemas = { ...this.KEY, ...this.__getFields() }
      schemaType = classSchemas[schemas[0]].getProp('type')
    } else {
      schemaType = schemas[0].getProp('type')
    }
    const isNumericKey = ['integer', 'number'].includes(schemaType)
    return isNumericKey
  }

  /**
   * Defines the key. Every item in the database is uniquely identified by its'
   * key. The default key is a UUIDv4.
   *
   * A key can simply be some scalar value:
   *   static KEY = { id: S.str }
   *
   * A key may can be "compound key", i.e., a key with one or components, each
   * with their own name and schema:
   *   static KEY = {
   *     email: S.str,
   *     birthYear: S.int.min(1900)
   *   }
   */
  static KEY = { id: S.SCHEMAS.UUID }

  /**
   * Defines the non-key fields. By default there are no fields.
   *
   * Properties are defined as a map from field names to a Todea schema:
   * @example
   *   static FIELDS = {
   *     someNumber: S.double,
   *     someNumberWithOptions: S.double.optional().default(0).readOnly()
   *   }
   */
  static FIELDS = {}

  get _id () {
    return this.__getKey(this.constructor.__keyOrder, this.constructor.KEY)
  }

  __getKey (keyOrder, keySchema) {
    const useNumericKey = this.constructor.__useNumericKey(keySchema)
    return this.constructor.__encodeCompoundValue(
      keyOrder,
      new Proxy(this, {
        get: (target, prop, receiver) => {
          return target.getField(prop).__value
        }
      }),
      useNumericKey
    )
  }

  static __getId (vals) {
    const useNumericKey = this.__useNumericKey(this.KEY)
    return this.__encodeCompoundValue(this.__keyOrder, vals, useNumericKey)
  }

  /**
   * Generate a compound field name given a list of fields.
   * For compound field containing a single field that is not a KEY,
   * we use the same name as the original field to reduce data duplication.
   * We also auto-detect if _id can be re-used
   *
   * @param [ fields ] a list of string denoting the fields
   * @returns a string denoting the compound field's internal name
   */
  static __encodeCompoundFieldName (fields) {
    if (fields.length === 1 && this.FIELDS[fields[0]] &&
      !['array', 'object', 'boolean'].includes(this.FIELDS[fields[0]].getProp('type'))) {
      return fields[0]
    }

    if (Object.keys(this.KEY).sort().join('\0') === fields.sort().join('\0')) {
      return '_id'
    }

    return __CompoundField.__encodeName(fields)
  }

  /**
   * Returns the underlying __Field associated with an attribute.
   *
   * @param {String} name the name of a field from FIELDS
   * @returns {BooleanField|ArrayField|ObjectField|NumberField|StringField}
   */
  getField (name) {
    assert(!name.startsWith('_'), 'may not access internal computed fields')
    return this.__attr_getters[name]()
  }

  /**
   * The table name this model is associated with, excluding the service ID
   * prefix. This is the model's class name. However, subclasses may choose to
   * override this method and provide duplicated table name for co-existed
   * models.
   *
   * @type {String}
   */
  static get tableName () {
    return this.name
  }

  /**
   * Returns the fully-qualified table name (Service ID + tableName).
   * @private
   */
  static get fullTableName () {
    return process.env.SERVICE + this.tableName
  }

  static get tableResourceName () {
    return 'DynamoDBTable' + this.fullTableName
  }

  /**
   * The table name this model is associated with.
   * Just a convenience wrapper around the static version of this method.
   * @private
   */
  get __fullTableName () {
    return Object.getPrototypeOf(this).constructor.fullTableName
  }

  /**
   * Given a mapping, split compositeKeys from other model fields. Return a
   * 3-tuple, [encodedKey, keyComponents, modelData].
   *
   * @param {Object} data data to be split
   */
  static __splitKeysAndData (data) {
    const keyComponents = {}
    const modelData = {}
    Object.keys(data).forEach(key => {
      if (this.__KEY_COMPONENT_NAMES.has(key)) {
        keyComponents[key] = data[key]
      } else if (this._attrs[key]) {
        modelData[key] = data[key]
      } else {
        throw new InvalidParameterError('data', 'unknown field ' + key)
      }
    })
    return [this.__getId(keyComponents), keyComponents, modelData]
  }

  /**
   * @access package
   * @param {String} encodedKey
   * @param {GetParams} options
   * @returns {Object} parameters for a get request to DynamoDB
   */
  static __getParams (encodedKey, options) {
    return {
      TableName: this.fullTableName,
      ConsistentRead: !options.inconsistentRead,
      Key: encodedKey
    }
  }

  /**
   * Parameters for fetching a model and options to control how a model is
   * fetched from database.
   * @typedef {Object} GetParams
   * @property {Boolean} [inconsistentRead=false] If true, model is read with
   *   strong consistency, else the read is eventually consistent.
   * @property {Boolean} [createIfMissing=false] If true, a model is returned
   *   regardless of whether the model exists on server. This behavior is the
   *   same as calling create when get(..., { createIfMissing: false }) returns
   *   undefined
   * @property {*} [*] Besides the predefined options, custom key-value pairs
   *   can be added. These values will be made available to the Model's
   *   constructor as an argument.
   */

  /**
   * Generates parameters for a put request to DynamoDB.
   * Put overrides item entirely, removing untracked fields from DynamoDB.
   * This library supports optimistic locking for put. Since put overrides all
   * fields of an item, optimistic locking is performed on all fields. This
   * means if any fields is modified after the item is read calling put would
   * fail. Effectively the lock applies to the entire item, which may lead to
   * more contention. Have update in most use cases is more desirable.
   *
   * @access package
   * @returns parameters for a put request to DynamoDB
   */
  __putParams () {
    // istanbul ignore next
    if (this.__src.isUpdate) {
      // This is really unreachable code.
      // The only way to get here is when the model is mutated (to complete a
      // write) and has no field mutated (so PUT is used instead of UPDATE).
      // It can happen only when the model isNew.
      // However, when items are setup from updateItem method, we pretend the
      // items to be not new. Hence, the condition will never be satisfied.
      // conditions.push('attribute_exists(_id)')
      assert(false, 'This should be unreachable unless something is broken.')
    }

    const item = this._id
    const accessedFields = []
    let exprCount = 0
    for (const [key, getter] of Object.entries(this.__attr_getters)) {
      const field = getter()
      field.validate()

      if (field.isKey) {
        continue
      }
      if (field.__value !== undefined) {
        // Not having undefined keys effectively removes them.
        // Also saves some bandwidth.
        item[key] = deepcopy(field.__value)
      }

      // Put works by overriding the entire item,
      // all fields needs to be written.
      // No need to check for field.accessed, pretend everything is accessed,
      // except for keys, since they don't change
      accessedFields.push(field)
    }

    let conditionExpr
    const exprAttrNames = {}
    const isCreateOrPut = this.__src.isCreateOrPut
    const exprValues = {}
    if (this.isNew) {
      if (isCreateOrPut) {
        const conditions = []
        for (const field of accessedFields) {
          const exprKey = `:_${exprCount++}`
          const [condition, vals] = field.__conditionExpression(exprKey)
          if (condition &&
            (!isCreateOrPut ||
             !condition.startsWith('attribute_not_exists'))) {
            conditions.push(condition)
            Object.assign(exprValues, vals)
            exprAttrNames[field.__awsName] = field.name
          }
        }
        conditionExpr = conditions.join(' AND ')

        if (conditionExpr.length !== 0) {
          const [cond, names, vals] = this.__nonexistentModelCondition()
          conditionExpr = `${cond} OR
            (${conditionExpr})`
          Object.assign(exprAttrNames, names)
          Object.assign(exprValues, vals)
        }
      } else {
        const [cond, names, vals] = this.__nonexistentModelCondition()
        conditionExpr = cond
        Object.assign(exprAttrNames, names)
        Object.assign(exprValues, vals)
      }
    } else {
      const conditions = [
        'attribute_exists(#_id)'
      ]
      exprAttrNames['#_id'] = '_id'
      for (const field of accessedFields) {
        const exprKey = `:_${exprCount++}`
        const [condition, vals] = field.__conditionExpression(exprKey)
        if (condition) {
          conditions.push(condition)
          Object.assign(exprValues, vals)
          exprAttrNames[field.__awsName] = field.name
        }
      }
      conditionExpr = conditions.join(' AND ')
    }

    const ret = {
      TableName: this.__fullTableName,
      Item: item
    }
    if (conditionExpr.length !== 0) {
      ret.ConditionExpression = conditionExpr
    }
    if (Object.keys(exprValues).length) {
      ret.ExpressionAttributeValues = exprValues
    }
    if (Object.keys(exprAttrNames).length) {
      ret.ExpressionAttributeNames = exprAttrNames
    }
    return ret
  }

  /**
   * Generates parameters for an update request to DynamoDB.
   * Update only overrides fields that got updated to a different value.
   * Untracked fields will not be removed from DynamoDB. This library supports
   * optimistic locking for update. Since update only touches specific fields
   * of an item, optimistic locking is only performed on fields accessed (read
   * or write). This locking mechanism results in less likely contentions,
   * hence is preferred over put.
   *
   * @access package
   * @param {Boolean} omitUpdates (default = false)
   * When True, generates only condition expressions for read values;
   * skipping update expressions, related Attribute Names/Values and schema validation,
   * with the expectation that any accessed value is either unmodified (and therefore valid)
   * or explicitly unchecked (written but not read).
   * @returns parameters for a update request to DynamoDB
   */
  __updateParams (omitUpdates = false) {
    const conditions = []
    const exprAttrNames = {}
    const exprValues = {}
    const itemKey = this._id
    const sets = []
    const removes = []
    const accessedFields = []
    let exprCount = 0

    const isUpdate = this.__src.isUpdate
    for (const field of Object.values(this.__cached_attrs)) {
      if (field.isKey) {
        // keys are never updated and not explicitly represented in store
        continue
      }
      if (field.accessed) {
        accessedFields.push(field)
      }
      if (!field.__mayHaveMutated || omitUpdates) {
        continue
      }

      field.validate()

      const exprKey = `:_${exprCount++}`
      const [set, vals, remove] = field.__updateExpression(exprKey)
      if (set) {
        sets.push(set)
        Object.assign(exprValues, vals)
      }
      if (remove) {
        removes.push(field.__awsName)
      }
      if (set || remove) {
        exprAttrNames[field.__awsName] = field.name
      }
    }

    if (this.isNew) {
      if (!this.__src.isCreateOrPut) {
        const [cond, names, vals] = this.__nonexistentModelCondition()
        conditions.push(cond)
        Object.assign(exprAttrNames, names)
        Object.assign(exprValues, vals)
      }
    } else {
      conditions.push('attribute_exists(#_id)')
      exprAttrNames['#_id'] = '_id'

      for (const field of accessedFields) {
        const exprKey = `:_${exprCount++}`
        const [condition, vals] = field.__conditionExpression(exprKey)
        if (
          condition &&
          (!isUpdate || !condition.startsWith('attribute_not_exists'))
        ) {
          // From update, initial values for fields aren't setup.
          // We only care about the fields that got setup. Here if the
          // condition is attribute_not_exists, we know the field wasn't setup,
          // so ignore it.
          conditions.push(condition)
          Object.assign(exprValues, vals)
          exprAttrNames[field.__awsName] = field.name
        }
      }
    }

    const ret = {
      TableName: this.__fullTableName,
      Key: itemKey
    }
    const actions = []
    if (sets.length) {
      actions.push(`SET ${sets.join(',')}`)
    }
    if (removes.length) {
      actions.push(`REMOVE ${removes.join(',')}`)
    }
    if (actions.length) {
      // NOTE: This is optional in DynamoDB's update call,
      // but required in the transactWrite.update counterpart.
      ret.UpdateExpression = actions.join(' ')
    }
    if (conditions.length) {
      ret.ConditionExpression = conditions.join(' AND ')
    }
    if (Object.keys(exprValues).length) {
      ret.ExpressionAttributeValues = exprValues
    }
    // istanbul ignore else
    if (Object.keys(exprAttrNames).length) {
      ret.ExpressionAttributeNames = exprAttrNames
    }
    return ret
  }

  __deleteParams () {
    const itemKey = this._id
    const ret = {
      TableName: this.__fullTableName,
      Key: itemKey
    }
    if (!this.isNew) {
      const conditions = []
      const attrNames = {}
      // Since model is not new, conditionCheckParams will always have contents
      const conditionCheckParams = this.__updateParams(true)
      conditions.push(conditionCheckParams.ConditionExpression)
      Object.assign(attrNames, conditionCheckParams.ExpressionAttributeNames)
      ret.ExpressionAttributeValues =
          conditionCheckParams.ExpressionAttributeValues

      ret.ConditionExpression = conditions.join(' AND ')
      ret.ExpressionAttributeNames = attrNames
    }
    return ret
  }

  /**
   * Indicates if any field was mutated. New models are considered to be
   * mutated as well.
   * @param {Boolean} expectWrites whether the model will be updated,
   *  default is true.
   * @type {Boolean}
   */
  __isMutated (expectWrites = true) {
    if (this.isNew) {
      return true
    }
    if (this.__toBeDeleted) {
      return true
    }
    for (const field of Object.values(this.__cached_attrs)) {
      if (field.hasChangesToCommit(expectWrites)) {
        // If any field has changes that need to be committed,
        // it will mark the model as mutated.
        return true
      }
    }
    return false
  }

  /**
   * Used for optimistic locking within transactWrite requests, when the model
   * was read in a transaction, and was subsequently used for updating other
   * models but never written back to DB. Having conditionCheck ensures this
   * model's data hasn't been changed so the updates to other models are also
   * correct.
   *
   * @access package
   * @returns {Boolean} An Object for ConditionCheck request.
   */
  __conditionCheckParams () {
    assert.ok(this.isNew || !this.__isMutated(),
      'Model is mutated, write it instead!')
    // Since model cannot be new, conditionCheckExpression will never be empty
    // (_id must exist)
    return this.__updateParams(true)
  }

  /**
   * Returns the string representation for the given compound values.
   *
   * This method throws {@link InvalidFieldError} if the compound value does
   * not match the required schema.
   *
   * @param {Array<String>} keyOrder order of keys in the string representation
   * @param {Object} values maps component names to values; may have extra
   *   fields (they will be ignored)
   */
  static __encodeCompoundValue (keyOrder, values, useNumericKey) {
    if (keyOrder.length === 0) {
      return undefined
    }

    const pieces = []
    for (let i = 0; i < keyOrder.length; i++) {
      const fieldName = keyOrder[i]
      const fieldOpts = this._attrs[fieldName]
      const givenValue = values[fieldName]
      if (givenValue === undefined) {
        throw new InvalidFieldError(fieldName, 'must be provided')
      }
      const valueType = validateValue(fieldName, fieldOpts, givenValue)
      if (useNumericKey) {
        return givenValue
      }
      if (valueType === String) {
        // the '\0' character cannot be stored in string fields. If you need to
        // store a string containing this character, then you need to store it
        // inside of an object field, e.g.,
        // item.someObjField = { myString: '\0' } is okay
        if (givenValue.indexOf('\0') !== -1) {
          throw new InvalidFieldError(
            fieldName, 'cannot put null bytes in strings in compound values')
        }
        pieces.push(givenValue)
      } else {
        pieces.push(stableStringify(givenValue))
      }
    }
    return pieces.join('\0')
  }

  /**
   * Returns the map which corresponds to the given compound value string
   *
   * This method throws {@link InvalidFieldError} if the decoded string does
   * not match the required schema.
   *
   * @param {Array<String>} keyOrder order of keys in the string representation
   * @param {String} strVal the string representation of a compound value
   * @param {String} attrName which key we're parsing
   */
  static __decodeCompoundValue (keyOrder, val, attrName, useNumericKey) {
    if (useNumericKey) {
      const fieldName = keyOrder[0]
      const fieldOpts = this._attrs[fieldName]
      validateValue(fieldName, fieldOpts, val)
      return { [fieldName]: val }
    }

    // Assume val is otherwise a string
    const pieces = val.split('\0')
    if (pieces.length !== keyOrder.length) {
      throw new InvalidFieldError(
        attrName, 'failed to parse key: incorrect number of components')
    }

    const compoundID = {}
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]
      const fieldName = keyOrder[i]
      const fieldOpts = this._attrs[fieldName]
      const valueType = SCHEMA_TYPE_TO_JS_TYPE_MAP[fieldOpts.schema.type]
      if (valueType === String) {
        compoundID[fieldName] = piece
      } else {
        compoundID[fieldName] = JSON.parse(piece)
      }

      validateValue(fieldName, fieldOpts, compoundID[fieldName])
    }
    return compoundID
  }

  /**
   * Returns a Key identifying a unique row in this model's DB table.
   * @param {*} vals map of key component names to values; if there is
   *   only one partition key field (whose type is not object), then this MAY
   *   instead be just that field's value.
   * @returns {Key} a Key object.
   */
  static key (vals) {
    const processedVals = this.__splitKeysAndDataWithPreprocessing(vals)
    const [encodedKey, keyComponents, data] = processedVals

    // ensure that vals only contained key components (no data components)
    const dataKeys = Object.keys(data)
    if (dataKeys.length) {
      dataKeys.sort()
      throw new InvalidParameterError('vals',
        `received non-key fields: ${dataKeys.join(', ')}`)
    }
    return new Key(this, encodedKey, keyComponents)
  }

  /**
   * Returns a Data fully describing a unique row in this model's DB table.
   * @param {*} vals like the argument to key() but also includes non-key data
   * @returns {Data} a Data object for use with tx.create() or
   *   tx.get(..., { createIfMissing: true })
   */
  static data (vals) {
    return new Data(this, ...this.__splitKeysAndDataWithPreprocessing(vals))
  }

  static __splitKeysAndDataWithPreprocessing (vals) {
    // if we only have one key component, then the `_id` **MAY** just be the
    // value rather than a map of key component names to values
    assert(this.__setupDone,
      `model ${this.name} one-time setup was not done (remember to export ` +
      'the model')
    const pKeyOrder = this.__keyOrder
    if (pKeyOrder.length === 1) {
      const pFieldName = pKeyOrder[0]
      if (!(vals instanceof Object) || !vals[pFieldName]) {
        vals = { [pFieldName]: vals }
      }
    }
    if (!(vals instanceof Object)) {
      throw new InvalidParameterError('values',
        'should be an object mapping key component names to values')
    }
    return this.__splitKeysAndData(vals)
  }

  __markForDeletion () {
    if (this.__toBeDeleted) {
      throw new ModelDeletedTwiceError(this)
    }
    this.__toBeDeleted = true
  }

  __writeMethod () {
    if (this.__toBeDeleted) {
      return 'delete'
    }
    const usePut = this.__src.isCreateOrPut
    return usePut ? 'put' : 'update'
  }

  /**
   * Writes model to database. Uses DynamoDB update under the hood.
   * @access package
   */
  async __write () {
    assert.ok(!this.__written, 'May write once')
    this.__written = true

    const method = this.__writeMethod()
    const params = this[`__${method}Params`]()
    const retries = 3
    let millisBackOff = 40
    for (let tryCnt = 0; tryCnt <= retries; tryCnt++) {
      try {
        await this.documentClient[method](params).promise().catch(
          // istanbul ignore next
          e => { throw new DBError('write model', e) }
        )
        return
      } catch (error) {
        if (!error.retryable) {
          const isConditionalCheckFailure =
            error.code === 'ConditionalCheckFailedException'
          if (isConditionalCheckFailure && this.__toBeDeleted) {
            throw new InvalidModelDeletionError(
              this.constructor.tableName, this._id)
          } else if (isConditionalCheckFailure && this.__src.isCreate) {
            throw new ModelAlreadyExistsError(
              this.constructor.tableName, this._id)
          } else if (isConditionalCheckFailure && this.__src.isUpdate) {
            throw new InvalidModelUpdateError(
              this.constructor.tableName, this._id)
          } else {
            throw error
          }
        }
      }
      if (tryCnt >= retries) {
        throw new Error('Max retries reached')
      }
      const offset = Math.floor(Math.random() * millisBackOff * 0.2) -
        millisBackOff * 0.1 // +-0.1 backoff as jitter to spread out conflicts
      await sleep(millisBackOff + offset)
      millisBackOff *= 2
    }
  }

  /**
   * @return a [ConditionExpression, ExpressionAttributeNames,
   *   ExpressionAttributeValues] tuple to make sure the model
   *   does not exist on server.
   */
  __nonexistentModelCondition () {
    const condition = 'attribute_not_exists(#_id)'
    const attrNames = {
      '#_id': '_id'
    }
    let attrValues
    return [
      condition,
      attrNames,
      attrValues
    ]
  }

  /**
   * Must be the same as NonExistentModel.toString() because it is used as the
   * unique identifier of an item for Objects and Sets.
   */
  toString () {
    return makeItemString(
      this.constructor,
      this._id
    )
  }

  toJSON () {
    return this.getSnapshot()
  }

  /**
   * Return snapshot of the model, all fields included.
   * @param {Object} params
   * @param {Boolean} params.initial Whether to return the initial state
   * @param {Boolean} params.dbKeys Whether to return _id instead of
   *   raw key fields.
   */
  getSnapshot ({ initial = false, dbKeys = false } = {}) {
    if (initial === false && this.__toBeDeleted) {
      return undefined
    }

    const ret = {}
    if (dbKeys) {
      if (!initial || !this.isNew) {
        Object.assign(ret, this._id)
      } else {
        ret._id = undefined
      }
    }
    for (const [name, getter] of Object.entries(this.__attr_getters)) {
      const field = getter()
      if (!field || field instanceof __CompoundField) {
        continue
      }
      if (field.isKey) {
        if (dbKeys) {
          continue
        }
      }
      if (initial) {
        ret[name] = field.__initialValue
      } else {
        ret[name] = field.__value
      }
    }
    return ret
  }
}

/**
 * Used for tracking a non-existent item.
 */
class NonExistentItem {
  constructor (key) {
    this.key = key
  }

  get __src () {
    return {
      isGet: true
    }
  }

  get _id () {
    return this.key.encodedKey
  }

  get __fullTableName () {
    return this.key.Cls.fullTableName
  }

  __isMutated () {
    return false
  }

  __conditionCheckParams () {
    const condition = 'attribute_not_exists(#_id)'
    const attrNames = {
      '#_id': '_id'
    }
    return {
      TableName: this.key.Cls.fullTableName,
      Key: this.key.encodedKey,
      ConditionExpression: condition,
      ExpressionAttributeNames: attrNames
    }
  }

  /**
   * Must be the same as Model.toString() because it is used as the unique
   * identifier of an item for Objects and Sets.
   */
  toString () {
    return makeItemString(
      this.key.Cls, this.key.encodedKey)
  }

  getSnapshot () {
    return undefined
  }
}

module.exports = {
  Model,
  NonExistentItem
}
