// Convenient helper to setup dynamodb connection using environment variables.
// The constructed db instance will be cached by NodeJS.
import { initializeApp } from 'firebase/app'
import { connectFirestoreEmulator, initializeFirestore } from 'firebase/firestore'

const setup = require('./firestore')

// TODO: get config from file e.g., require(process.env.FIREBASE_CONFIG_FILE)
const firebaseConfig = {}
const firebaseApp = initializeApp(firebaseConfig)

export const firestoreClient = initializeFirestore(firebaseApp, {
  ignoreUndefinedProperties: true
})

// configure firestore to use emulators if on localhost AND the
// USE_EMULATOR environment variable is set
if (window.location.hostname === 'localhost' && process.env.USE_EMULATOR) {
  connectFirestoreEmulator(firestoreClient, 'localhost', 8110)
}

module.exports = setup(firestoreClient)
