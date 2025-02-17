const {
  InvalidFieldError,
  InvalidOptionsError,
  InvalidParameterError
} = require('./errors')

function validateValue (fieldName, opts, val) {
  const schema = opts.schema
  const valueType = SCHEMA_TYPE_TO_JS_TYPE_MAP[schema.type]

  // handle omitted value
  if (val === undefined) {
    if (opts.optional) {
      return valueType
    } else {
      throw new InvalidFieldError(fieldName, 'missing required value')
    }
  }

  // validate the value against the provided schema
  opts.assertValid(val)
  return valueType
}

const SCHEMA_TYPE_TO_JS_TYPE_MAP = {
  array: Array,
  boolean: Boolean,
  integer: Number,
  number: Number,
  float: Number,
  object: Object,
  string: String
}

async function sleep (millis) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, millis)
  })
}

function checkUnexpectedOptions (options, defaults) {
  if (typeof options !== 'object') {
    throw new InvalidParameterError('options', 'must be an object')
  }
  Object.keys(options).forEach(opt => {
    if (!Object.prototype.hasOwnProperty.call(defaults, opt)) {
      throw new InvalidOptionsError(opt, 'Unexpected option. ' +
        `Valid options are ${Object.keys(defaults)}`)
    }
    const optionVal = options[opt]
    const defaultVal = defaults[opt]
    if (optionVal !== undefined &&
        defaultVal !== undefined &&
        typeof optionVal !== typeof defaultVal) {
      throw new InvalidOptionsError(opt, 'Unexpected option. ' +
        `Invalid type for option ${opt}. Expected ${typeof defaultVal}`)
    }
  })
}

function loadOptionDefaults (options, defaults) {
  // istanbul ignore next
  options = options || {}
  checkUnexpectedOptions(options, defaults)
  const retOptions = Object.assign({}, defaults)
  return Object.assign(retOptions, options)
}

module.exports = {
  checkUnexpectedOptions,
  loadOptionDefaults,
  SCHEMA_TYPE_TO_JS_TYPE_MAP,
  sleep,
  validateValue
}
