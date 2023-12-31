// Convenient helper to setup our db connection using environment variables.
// The constructed db instance will be cached by NodeJS.
import Firestore from '@google-cloud/firestore'

const setup = require('./firestore')

// make Firestore look like the Transaction object (it already has getAll but
// does not have these others)
Firestore.prototype.get = async (docRef) => docRef.get()
Firestore.prototype.delete = async (docRef) => docRef.delete()
Firestore.prototype.create = async (docRef, data) => docRef.create(data)
Firestore.prototype.set = async (docRef, data, options) => docRef.set(data, options)
Firestore.prototype.update = async (docRef, data) => docRef.update(data)

// TODO: get "host" field based on environment (e.g., dev or prod)
// automatically uses the emulator when FIRESTORE_EMULATOR_HOST is set
const firestoreClient = new Firestore({
  ignoreUndefinedProperties: true
})

module.exports = setup(firestoreClient)
