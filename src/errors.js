/**
 * @namespace Errors
 */

/**
 * Thrown when supplied option is invalid.
 *
 * @access public
 * @memberof Errors
 */
class InvalidOptionsError extends Error {
  constructor (option, expectation) {
    super(`Invalid option value for ${option}. ${expectation}.`)
    this.name = this.constructor.name
  }
}

/**
 * Thrown when some parameter is invalid.
 *
 * @access public
 * @memberof Errors
 */
class InvalidParameterError extends Error {
  constructor (param, expectation) {
    super(`Invalid parameter ${param}. ${expectation}.`)
    this.name = this.constructor.name
  }
}

/**
 * Thrown when the library detects a field to be in an invalid state.
 *
 * @access public
 * @memberof Errors
 */
class InvalidFieldError extends Error {
  constructor (field, reason) {
    super(`${field} ${reason}`)
    this.name = this.constructor.name
  }
}

/**
 * Thrown when a transaction fails.
 * Original exception is attached to property `original`
 * Original stack is appended to current stack.
 *
 * @arg {string} msg the error message
 * @arg {Error} [originalException] the original error which led to this
 * @access public
 * @memberof Errors
 */
class TransactionFailedError extends Error {
  constructor (msg, originalException) {
    super(msg)
    this.name = this.constructor.name
    this.original = originalException
    if (originalException instanceof Error) {
      this.stack += '\n' + originalException.stack
    }
  }
}

class TransactionLockTimeoutError extends TransactionFailedError {
  constructor (reason, original) {
    super(reason, original)
    this.name = this.constructor.name
    this.retryable = true
  }
}

/**
 * Thrown when there's some error with a particular model.
 * @memberof Errors
 */
class GenericModelError extends Error {
  constructor (msg, table, _id) {
    super(`${msg}: ${table} _id=${_id}`)
    this.name = this.constructor.name
    this.retryable = false
  }
}

/**
 * Thrown when a model is to be created, but DB already has an item with the
 * same key.
 * @memberof Errors
 */
class ModelAlreadyExistsError extends GenericModelError {
  constructor (table, _id) {
    super('Tried to recreate an existing model', table, _id)
  }
}

/**
 * Thrown when a model is to be updated, but condition check failed.
 * @memberof Errors
 */
class UpdateRequiredModelToExistError extends GenericModelError {
  constructor (table, _id) {
    super('Tried to update model but it did not exist as required',
      table, _id)
  }
}

/**
 * Thrown when an attempt to get a model that is deleted or created in a
 * transaction where cachedModels option is on.
 * @memberof Errors
 */
class InvalidCachedModelError extends GenericModelError {
  constructor (model) {
    super('Model is not a valid cached model',
      model.constructor.tableName, model._id)
  }
}

/**
 * Thrown when model is tracked more than once inside a transaction.
 */
class ModelTrackedTwiceError extends GenericModelError {
  constructor (key, trackedModel) {
    const msg = 'Model tracked twice'
    super(msg, key.Cls.tableName, key.encodedKey)
    this.newKey = key
    this.trackedModel = trackedModel
  }
}

/**
 * Thrown when a model is being deleted more than once.
 * @memberof Errors
 */
class DeletedTwiceError extends GenericModelError {
  constructor (tableName, _id) {
    super('Tried to delete model when it\'s already deleted in the current tx',
      tableName, _id)
  }
}

/**
 * Thrown when a tx tries to write when it was marked read-only.
 * @memberof Errors
 */
class WriteAttemptedInReadOnlyTxError extends Error {
  constructor (dataToWrite) {
    super(`Tried to write model in a read-only transaction with the following
      changes ${JSON.stringify(dataToWrite)}`)
  }
}

class InvalidFilterError extends Error {
  constructor (reason) {
    super(reason)
    this.name = this.constructor.name
  }
}

class NotImplementedError extends Error {
  constructor (reason) {
    super(reason)
    this.name = this.constructor.name
  }
}

module.exports = {
  GenericModelError,
  InvalidCachedModelError,
  InvalidFieldError,
  InvalidFilterError,
  InvalidOptionsError,
  InvalidParameterError,
  ModelAlreadyExistsError,
  DeletedTwiceError,
  ModelTrackedTwiceError,
  NotImplementedError,
  TransactionFailedError,
  TransactionLockTimeoutError,
  UpdateRequiredModelToExistError,
  WriteAttemptedInReadOnlyTxError
}
