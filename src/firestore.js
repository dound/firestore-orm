const S = require('@pocketgems/schema')

const {
  InvalidCachedModelError,
  InvalidFieldError,
  InvalidModelDeletionError,
  InvalidModelUpdateError,
  InvalidOptionsError,
  InvalidParameterError,
  ModelAlreadyExistsError,
  ModelDeletedTwiceError,
  ModelTrackedTwiceError,
  TransactionFailedError,
  WriteAttemptedInReadOnlyTxError
} = require('./errors')
const {
  __Field,
  ArrayField,
  BooleanField,
  NumberField,
  ObjectField,
  StringField
} = require('./fields')
const Filter = require('./filter')
const { Query, Scan } = require('./iterators')
const { UniqueKeyList } = require('./key')
const { Model } = require('./models')
const {
  __WriteBatcher,
  getWithArgs,
  Transaction
} = require('./transaction')
const {
  ITEM_SOURCE
} = require('./utils')

/**
 * @module firestore
 */

/**
 * Setup the Firestore library before returning symbols clients can use.
 *
 * @param {Object} [firestoreClient] client to interact with db items; from
 *   firebase/app::initializeApp
 * @returns {Object} Symbols that clients of this library can use.
 * @private
 */
function setup (firestoreClient) {
  // Make DynamoDB document clients available to these classes
  const clsWithDBAccess = [
    __WriteBatcher,
    Model,
    Query,
    Scan,
    Transaction
  ]
  clsWithDBAccess.forEach(Cls => {
    Cls.firestoreClient = firestoreClient
    Cls.prototype.firestoreClient = firestoreClient
  })

  const exportAsClass = {
    S,
    Model,
    UniqueKeyList,
    Transaction,

    // Errors
    InvalidFieldError,
    InvalidModelDeletionError,
    InvalidModelUpdateError,
    InvalidCachedModelError,
    InvalidOptionsError,
    InvalidParameterError,
    ModelDeletedTwiceError,
    ModelTrackedTwiceError,
    ModelAlreadyExistsError,
    TransactionFailedError,
    WriteAttemptedInReadOnlyTxError
  }

  const toExport = Object.assign({}, exportAsClass)
  if (Number(process.env.INDEBUGGER)) {
    toExport.__private = {
      __Field,
      __WriteBatcher,
      Filter,
      fields: [
        ArrayField,
        BooleanField,
        NumberField,
        ObjectField,
        StringField
      ],
      getWithArgs,
      ITEM_SOURCE,
      Query,
      Scan
    }
  }
  return toExport
}

module.exports = setup
