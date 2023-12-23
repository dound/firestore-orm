// Convenient helper to setup dynamodb connection using environment variables.
// The constructed db instance will be cached by NodeJS.

const setup = require('./firestore')

const inDebugger = !!Number(process.env.INDEBUGGER)

module.exports = setup({
  // TODO
})
