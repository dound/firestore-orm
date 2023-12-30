const assert = require('assert')

const S = require('@pocketgems/schema')
const stableStringify = require('fast-json-stable-stringify')

const { Data } = require('./data')
const {
  InvalidFieldError,
  InvalidParameterError
} = require('./errors')
const { __Field, SCHEMA_TYPE_TO_FIELD_CLASS_MAP } = require('./fields')
const { Key } = require('./key')
const {
  validateValue,
  makeItemString,
  SCHEMA_TYPE_TO_JS_TYPE_MAP
} = require('./utils')

/**
 * The base class for modeling data.
 */
class Model {
  /**
   * Create a representation of a database Item. Should only be used by the
   * library.
   */
  constructor (isNew, vals, isForUpdateAndMayBePartial = false, isSet = false) {
    this.constructor.__doOneTimeModelPrep()
    assert.ok(typeof isNew === 'boolean', 'isNew must be a boolean')
    assert.ok(typeof isForUpdateAndMayBePartial === 'boolean',
      'isForUpdateAndMayBePartial must be a boolean')
    this.isNew = isNew
    this.__isPartial = isForUpdateAndMayBePartial
    this.__isSet = isSet
    assert.ok(!isSet || !isForUpdateAndMayBePartial,
      'may not be partial when using isSet')

    // __cached_attrs has a __Field subclass object for each non-key attribute.
    this.__cached_attrs = {}

    // __cached_attrs has a __Field subclass object for each non-key attribute.
    this.__attr_getters = {}

    // pull out the Key for this item
    let keyComponents
    if (vals.__id !== undefined) {
      keyComponents = this.constructor.__decodeCompoundValue(
        this.constructor.__keyOrder, vals._id)
      delete vals._id
      Object.assign(vals, keyComponents)
    } else {
      this.__key = this.constructor.key(vals, true)
    }

    // add user-defined fields from FIELDS & key components from KEY
    for (const [name, opts] of Object.entries(this.constructor._attrs)) {
      this.__addField(name, opts, vals)
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
    const valSpecified = Object.hasOwnProperty.call(vals, name)
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
        val: vals[name],
        valIsFromDB: !this.isNew && !this.__isPartial,
        valSpecified: valSpecified,
        isForUpdate: this.__isPartial
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
    return this.constructor.__encodeCompoundValue(
      this.constructor.__keyOrder,
      new Proxy(this, {
        get: (target, prop, receiver) => {
          return target.getField(prop).__value
        }
      })
    )
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
   * The table name this model is associated with. This is the model's class
   * name. However, subclasses may choose to override this method and provide
   * duplicated table name for co-existed models.
   *
   * @type {String}
   */
  static get tableName () {
    return this.name
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
    const _id = this.__encodeCompoundValue(this.__keyOrder, keyComponents)
    return [_id, keyComponents, modelData]
  }

  __write (ctx) {
    const docRef = this.__key.docRef
    this.finalize()
    const data = {}
    for (const field of Object.values(this.__cached_attrs)) {
      if (!field.isKey) {
        if (this.isNew || field.hasChangesToCommit(true)) {
          const val = field.__valueForFirestoreWrite()
          if (val !== undefined) {
            data[field.name] = val
          }
        }
      }
    }

    if (this.isNew) {
      // write the entire document from scratch
      if (this.__isSet) {
        // overwrite if it already exists (create if missing)
        ctx.__dbCtx.set(docRef, data, { merge: false })
      } else {
        // fail if it already exists
        ctx.__dbCtx.create(docRef, data)
      }
    } else {
      ctx.__dbCtx.update(docRef, data)
    }
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
   * Returns the string representation for the given compound values.
   *
   * This method throws {@link InvalidFieldError} if the compound value does
   * not match the required schema.
   *
   * @param {Array<String>} keyOrder order of keys in the string representation
   * @param {Object} values maps component names to values; may have extra
   *   fields (they will be ignored)
   */
  static __encodeCompoundValue (keyOrder, values) {
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
   */
  static __decodeCompoundValue (keyOrder, val) {
    // Assume val is otherwise a string
    const pieces = val.split('\0')
    if (pieces.length !== keyOrder.length) {
      throw new InvalidFieldError(
        'KEY', 'failed to parse key: incorrect number of components')
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
  static key (vals, ignoreData = false) {
    const processedVals = this.__splitKeysAndDataWithPreprocessing(vals)
    const [encodedKey, keyComponents, data] = processedVals

    // ensure that vals only contained key components (no data components)
    const dataKeys = Object.keys(data)
    if (dataKeys.length && !ignoreData) {
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
    this.__doOneTimeModelPrep()
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
   * @param {Boolean} params.omitKey whether to omit the key
   */
  getSnapshot ({ initial = false, dbKeys = false, omitKey = false } = {}) {
    const ret = {}
    if (dbKeys && !omitKey) {
      if (!initial || !this.isNew) {
        assert.ok(typeof this._id === 'string')
        ret._id = this._id
      } else {
        ret._id = undefined
      }
    }
    for (const [name, getter] of Object.entries(this.__attr_getters)) {
      const field = getter()
      if (!field) {
        continue
      }
      if (field.isKey) {
        if (dbKeys || omitKey) {
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

module.exports = {
  Model
}
