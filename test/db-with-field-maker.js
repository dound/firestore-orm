const assert = require('assert')

const S = require('@pocketgems/schema')

const db = require('../src/default-db')

db.verifyDoc = async (ModelCls, id, data) => {
  const docRef = db.firestoreDB.collection(ModelCls.tableName).doc(id)
  const doc = await docRef.get()
  if (data) {
    expect(doc.exists).toBe(true)
    const data = await doc.data()
    expect(data).toEqual(data)
  } else {
    expect(doc.exists).toBe(false)
  }
}

// create helper functions to construct fields for testing purposes
db.__private.fields.forEach(Cls => {
  db.__private[Cls.name] = opts => fieldFromFieldOptions(Cls, opts)
})
function fieldFromFieldOptions (Cls, options) {
  options = options || {}
  let schema
  function processOption (key, func) {
    if (Object.hasOwnProperty.call(options, key)) {
      const val = options[key]
      if (func) {
        schema = func(val)
      }
      delete options[key]
      return val
    }
  }
  // schema is required; fill in the default if none is provided
  processOption('schema', schema => schema)
  if (!schema) {
    if (Cls.name === 'ArrayField') {
      schema = S.arr()
    } else if (Cls.name === 'BooleanField') {
      schema = S.bool
    } else if (Cls.name === 'NumberField') {
      schema = S.double
    } else if (Cls.name === 'ObjectField') {
      schema = S.obj()
    } else {
      assert.ok(Cls.name === 'StringField', 'unexpected class: ' + Cls.name)
      schema = S.str
    }
  }
  let initVal
  let valSpecified = true
  if (Object.hasOwnProperty.call(options, 'val')) {
    initVal = options.val
    delete options.val
  } else if (options.default) {
    initVal = undefined
    valSpecified = false
  } else {
    initVal = {
      ArrayField: [],
      BooleanField: false,
      NumberField: 0,
      ObjectField: {},
      StringField: ''
    }[Cls.name]
  }
  const valIsFromDB = processOption('valIsFromDB')
  const isKey = processOption('isKey')
  processOption('optional', isOpt => isOpt ? schema.optional() : schema)
  processOption('immutable', isReadOnly => schema.readOnly(isReadOnly))
  processOption('default', val => schema.default(val))
  const optionKeysLeft = Object.keys(options)
  assert.ok(optionKeysLeft.length === 0,
      `unexpected option(s): ${optionKeysLeft}`)
  const name = 'fakeTestField'
  options = db.__private.__Field.__validateFieldOptions(
    'fakeTestData', isKey, name, schema)
  return new Cls({
    name,
    opts: options,
    val: initVal,
    valIsFromDB,
    valSpecified,
    isForUpdate: false
  })
}

module.exports = db
