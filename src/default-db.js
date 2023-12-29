// Convenient helper to setup dynamodb connection using environment variables.
// The constructed db instance will be cached by NodeJS.
import Firestore from '@google-cloud/firestore'

const setup = require('./firestore')

// TODO: get "host" field based on environment (e.g., dev or prod)
// automatically uses the emulator when FIRESTORE_EMULATOR_HOST is set
const firestoreClient = new Firestore({
  ignoreUndefinedProperties: true
})

module.exports = setup(firestoreClient)
