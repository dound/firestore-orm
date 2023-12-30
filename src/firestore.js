const S = require('@pocketgems/schema')

const {
  getWithArgs,
  Context
} = require('./context')
const {
  InvalidFieldError,
  InvalidOptionsError,
  InvalidParameterError,
  ModelAlreadyExistsError,
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
const { Key, UniqueKeyList } = require('./key')
const { Model } = require('./models')

/**
 * @module firestore
 */

/**
 * Setup the Firestore library before returning symbols clients can use.
 *
 * @param {Object} [firestoreDB] client to interact with db items; from
 *   firebase/app::initializeApp
 * @returns {Object} Symbols that clients of this library can use.
 * @private
 */
function setup (firestoreDB) {
  Key.firestoreDB = firestoreDB
  const toExport = {
    S,
    Model,
    UniqueKeyList,
    Context,
    firestoreDB,

    // Errors
    InvalidFieldError,
    InvalidOptionsError,
    InvalidParameterError,
    ModelTrackedTwiceError,
    ModelAlreadyExistsError,
    TransactionFailedError,
    WriteAttemptedInReadOnlyTxError
  }
  if (Number(process.env.INDEBUGGER)) {
    toExport.__private = {
      __Field,
      fields: [
        ArrayField,
        BooleanField,
        NumberField,
        ObjectField,
        StringField
      ],
      getWithArgs
    }
  }
  return toExport
}

module.exports = setup
