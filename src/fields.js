const assert = require('assert')

const { FieldValue } = require('@google-cloud/firestore')
const deepeq = require('fast-deep-equal')
const deepcopy = require('rfdc')()

const { InvalidFieldError, InvalidOptionsError, NotImplementedError } = require('./errors')
const { validateValue } = require('./utils')

/**
 * Abstract class representing a field / property of a Model.
 *
 * @private
 * @memberof Internal
 */
class __FieldInterface {
  constructor () {
    if (this.constructor === __FieldInterface) {
      throw new Error('Can not instantiate abstract class')
    }
  }

  get mutated () {
    throw new NotImplementedError()
  }

  get __mayHaveMutated () {
    throw new NotImplementedError()
  }

  get accessed () {
    throw new NotImplementedError()
  }

  get () {
    throw new NotImplementedError()
  }

  set (val) {
    throw new NotImplementedError()
  }

  __valueForFirestoreWrite () {
    throw new NotImplementedError()
  }

  validate () {
    throw new NotImplementedError()
  }

  hasChangesToCommit (expectWrites = true) {
    throw new NotImplementedError()
  }
}

/**
 * @namespace Fields
 * @memberof Internal
 */

/**
 * @namespace Internal
 */

/**
 * Base class representing a field / property of a Model.
 *
 * @private
 * @memberof Internal
 */
class __BaseField extends __FieldInterface {
  /*
   * Indicates if any changes need to be committed in the field.
   * @param {Boolean} expectWrites whether the model will be updated,
   *  default is true.
   * @type {Boolean}
   */
  hasChangesToCommit (expectWrites = true) {
    // If a field is changed due to being initialized with the default
    // value within a read-only transaction, the change shouldn't be committed.
    // Otherwise, an error will occur when attempting to update in a
    // read-only transaction.
    if (this.__isForUpdate) {
      return true
    }
    const initDefault = !expectWrites && this.__useDefault && !this.__written
    return this.mutated && !initDefault
  }
}

/**
 * Internal object representing a field / property of a Model.
 *
 * @private
 * @memberof Internal
 */
class __Field extends __BaseField {
  static __validateFieldOptions (modelName, isKey, fieldName, schema) {
    if (fieldName.startsWith('_')) {
      throw new InvalidFieldError(
        fieldName, 'property names may not start with "_"')
    }

    if (isKey === undefined) {
      isKey = false
    }
    assert([true, false].includes(isKey), 'isKey must be true or false')
    assert(schema.isTodeaSchema, 'must be Todea schema')

    const compiledSchema = schema.getValidatorAndJSONSchema(
      `${modelName}.${fieldName}`)
    const jsonSchema = compiledSchema.jsonSchema
    const options = {
      isKey,
      schema: jsonSchema,
      optional: schema.required === false,
      immutable: isKey || jsonSchema.readOnly === true,
      default: jsonSchema.default,
      assertValid: compiledSchema.assertValid
    }
    const FieldCls = SCHEMA_TYPE_TO_FIELD_CLASS_MAP[options.schema.type]
    assert.ok(FieldCls, `unsupported field type ${options.schema.type}`)

    const hasDefault = Object.prototype.hasOwnProperty.call(jsonSchema, 'default')
    if (isKey) {
      if (hasDefault && isKey) {
        throw new InvalidOptionsError('default',
          'No defaults for keys.') // It just doesn\'t make sense.
      }
      if (jsonSchema.readOnly === false) {
        throw new InvalidOptionsError('immutable',
          'Keys must be immutable.')
      }
      if (options.optional) {
        throw new InvalidOptionsError('optional',
          'Keys must never be optional.')
      }
    }
    if (hasDefault) {
      validateValue(this.name, options, options.default)
    }
    return options
  }

  /**
   * @typedef {Object} FieldOptions
   * @property {Boolean} [isKey=false] If true, the field is
   *   a key. When specified, other options are forced to be
   *   { optional: false, immutable: true, default: undefined }. If user
   *   supplied values that conflicts with those values, InvalidOptionsError
   *   will be thrown.
   * @property {Boolean} [optional=false] If field can be left undefined.
   * @property {Boolean} [immutable=false] If field can be changed again after
   *   value is set to anything except undefined.
   * @property {*} [default=undefined] Default value to use. IMPORTANT: Value
   *   is deeply copied, so additional modifications to the parameter will
   *   not reflect in the field.
   * @property {schema} [schema=undefined] An optional JSON schema
   *   to validate Field's value.
   */

  /**
   * @param {String} name the field's name (also the name of the underlying
   *   attribute in the database where this field is stored [except key
   *   components which are not stored in the db in their own attribute])
   * @param {FieldOptions} opts
   * @param {*} val the initial value of the field
   * @param {boolean} valIsFromDB whether val is from (or is expected to be
   *   from) the database
   * @param {boolean} valSpecified whether val was specified (if this is
   *   true, then the field was present)
   * @param {boolean} isForUpdate whether this field is part of an update
   */
  constructor ({
    name,
    opts,
    val,
    valIsFromDB,
    valSpecified,
    isForUpdate
  }) {
    super()
    for (const [key, value] of Object.entries(opts)) {
      Object.defineProperty(this, key, { value, writable: false })
    }

    // Setup states
    /**
     * @memberof Internal.__Field
     * @instance
     * @member {String} name The name of the owning property.
     */
    this.name = name
    this.__value = undefined
    this.__readInitialValue = false // If get is called
    this.__written = false // If set is called
    this.__default = opts.default // only used for new items!

    // determine whether to use the default value, or the given val
    let useDefault
    if (valSpecified) {
      // if val was specified, then use it
      useDefault = false
    } else {
      assert.ok(val === undefined,
        'valSpecified can only be false if val is undefined')
      if (this.__default === undefined) {
        // can't use the default if there is no default value
        useDefault = false
      } else if (valIsFromDB && this.optional) {
        // if the field is optional and the value is not in the db then we
        // can't use the default (we have to assume the field was omitted)
        useDefault = false
      } else {
        useDefault = true
      }
    }

    this.__useDefault = useDefault
    this.__value = useDefault ? deepcopy(this.__default) : val

    if (valIsFromDB) {
      // The field's current value is the value stored in the database. Track
      // that value so that we can detect if it changes, and write that
      // change to the database.
      // Note: val is undefined whenever useDefault is true
      this.__initialValue = deepcopy(val)
    } else {
      this.__initialValue = undefined
    }

    // validate the value, if needed
    if (!this.isKey) { // keys are validated elsewhere; don't re-validate
      if (!useDefault) { // default was validated by __validateFieldOptions
        // validate everything except values omitted from an update() call
        if (valSpecified || !isForUpdate) {
          this.validate()
        }
      }
    }
    if (valSpecified && isForUpdate) {
      this.__isForUpdate = true
    }
  }

  /**
   * Returns the update value to give to Firestore. Assumes the value has been
   * mutated!
   */
  __valueForFirestoreWrite () {
    if (this.__value === undefined) {
      if (this.__initialValue !== undefined || this.__isForUpdate) {
        return FieldValue.delete()
      }
    }
    // complex types (objects and arrays) can be modified without calling set()
    // so we need to double-check the validation for them at this point
    this.validate()
    return deepcopy(this.__value)
  }

  /**
   * This method compares initialValue against the current value.
   *
   * @returns if value was changed.
   */
  get mutated () {
    return this.__value !== this.__initialValue
  }

  /**
   * A quick heuristic on if current value may differ from db. When this value
   * is true, use comparison / deep equality to confirm if the value has been
   * mutated. If this value is false, then the field must not have been
   * mutated, and there is no need to confirm mutation further.
   */
  get __mayHaveMutated () {
    // A field may be mutated when it's written or if the value is a complex
    // structure when it is read.
    if (this.accessed) {
      return true
    }
    // A field may still be mutated when it's never read or written, since the
    // field may be initialized with a mutated value (default value from schema
    // or default value upon creation).
    if (this.__initialValue === undefined && this.__value !== undefined) {
      return true
    }
    // Else the field must not be different from what's in database.
    return false
  }

  /**
   * This is primarily used for optimistic locking.
   * @returns {Boolean} if the field was accessed (read / write) by users of
   *   this library
   */
  get accessed () {
    return this.__readInitialValue || this.__written
  }

  /**
   * Gets the field's current value. Calling this method will mark the field as
   * "{@link accessed}".
   *
   * @see {@link __value} for accessing value within the library without
   *   "accessing" the field
   * @access public
   */
  get () {
    if (!this.__written) {
      this.__readInitialValue = true
    }
    return this.__value
  }

  /**
   * If the value passed in is valid, update field's current value, mark the
   * field as "{@link accessed}". If the value is not valid, throws
   * InvalidFieldError.
   *
   * @param {*} value New value for the field.
   * @affects {@link __Field#accessed}
   * @access public
   */
  set (val) {
    if (this.immutable) {
      throw new InvalidFieldError(
        this.name,
        'is immutable so value cannot be changed after first initialized.')
    }

    const prev = [this.__value, this.__written]
    this.__value = val
    this.__written = true

    try {
      this.validate()
    } catch (e) {
      [this.__value, this.__written] = prev
      throw e
    }
  }

  /**
   * Checks if the field's current value is valid. Throws InvalidFieldError if
   * check fails.
   */
  validate () {
    validateValue(this.name, this, this.__value)
  }
}

/**
 * @extends Internal.__Field
 * @memberof Internal.Fields
 * @private
 */
class NumberField extends __Field {
  constructor (options) {
    super(options)
    this.__diff = undefined
    this.__mustUseSet = false

    // figure out what value the diff will be added to
    if (this.__initialValue !== undefined) {
      // this occurs when the field is on an existing item AND the item already
      // had a value for the field
      this.__base = this.__initialValue
    } else if (this.__value !== undefined) {
      // this case occurs when the field is on a new item
      this.__base = this.__value
    } else {
      // this case occurs if the field is not currently present on the item;
      // in this case increment cannot be used to update the item
      this.__base = undefined
    }
  }

  set (val) {
    super.set(val)
    // don't change any state unless set() succeeds
    this.__diff = undefined // no longer computed as a diff
    this.__mustUseSet = true
  }

  /**
   * Updates the field's value by an unconditioned increment IF the field is
   * never read (reduces contention). If the field is ever read, there's no
   * reason to use this.
   * @param {Number} diff The diff amount.
   */
  incrementBy (diff) {
    // add the new diff to our current diff, if any
    // wait to set __diff until after super.set() succeeds to ensure no
    // changes are made if set() fails!
    const newDiff = (this.__diff === undefined) ? diff : this.__diff + diff

    // if we've already read the value, there's no point in generating an
    // increment update expression as we must lock on the original value anyway
    if (this.__readInitialValue || this.__mustUseSet) {
      this.set(this.__sumIfValid(false, newDiff))
      // this.__diff isn't set because we can't not using diff updates now
      return
    }

    // call directly on super to avoid clearing the diff value
    super.set(this.__sumIfValid(true, newDiff))
    this.__diff = newDiff
  }

  /**
   * Returns the sum of diff and some value. Throws if the latter is undefined.
   * @param {boolean} fromBase whether to add __base (else __value)
   * @param {number} diff how much to add
   * @returns {number} sum
   */
  __sumIfValid (fromBase, diff) {
    const base = fromBase ? this.__base : this.__value
    if (base === undefined) {
      throw new InvalidFieldError(
        this.name, 'cannot increment a field whose value is undefined')
    }
    return base + diff
  }

  /**
   * Whether this field can be updated with an increment expression.
   */
  get canUpdateWithIncrement () {
    return (
      // if there's no diff, we cannot use increment
      this.__diff !== undefined &&
      // if the field didn't have an old value, we can't increment it (DynamoDB
      // will throw an error if we try to do X=X+1 when X has no value)
      this.__initialValue !== undefined &&
      // if we read the value, then it's not a blind increment
      !this.__readInitialValue)
  }

  __valueForFirestoreWrite () {
    // if we're locking, there's no point in doing an increment
    if (this.canUpdateWithIncrement) {
      return FieldValue.increment(this.__diff)
    }
    return super.__valueForFirestoreWrite()
  }
}

/**
 * @extends Internal.__Field
 * @memberof Internal.Fields
 * @private
 */
class StringField extends __Field {
  get mutated () {
    return this.__mayHaveMutated && super.mutated
  }
}

/**
 * @extends Internal.__Field
 * @memberof Internal.Fields
 * @private
 */
class ObjectField extends __Field {
  /**
   * This method checks for equality deeply against the initial
   * value so use it as sparsely as possible. It is primarily meant to be
   * used internally for deciding whether a field needs to be transmitted to
   * the server.
   *
   * @returns if value was changed.
   */
  get mutated () {
    return this.__mayHaveMutated && !deepeq(this.__value, this.__initialValue)
  }
}

/**
 * @extends Internal.__Field
 * @memberof Internal.Fields
 * @private
 */
class BooleanField extends __Field {}

/**
 * @extends Internal.__Field
 * @memberof Internal.Fields
 * @private
 */
class ArrayField extends __Field {
  /**
   * This method checks for equality deeply against the initial
   * value so use it as sparsely as possible. It is primarily meant to be
   * used internally for deciding whether a field needs to be transmitted to
   * the server.
   *
   * @returns if value was changed.
   */
  get mutated () {
    return this.__mayHaveMutated && !deepeq(this.__value, this.__initialValue)
  }
}

const SCHEMA_TYPE_TO_FIELD_CLASS_MAP = {
  array: ArrayField,
  boolean: BooleanField,
  float: NumberField,
  integer: NumberField,
  number: NumberField,
  object: ObjectField,
  string: StringField
}

module.exports = {
  __FieldInterface,
  __Field,
  NumberField,
  ArrayField,
  BooleanField,
  StringField,
  ObjectField,
  SCHEMA_TYPE_TO_FIELD_CLASS_MAP
}
