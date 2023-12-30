const S = require('@pocketgems/schema')
const { BaseTest, runTests } = require('@pocketgems/unit-test')

const { NotImplementedError } = require('../src/errors')
const { __FieldInterface } = require('../src/fields')

const db = require('./db-with-field-maker')

class CommonFieldTest extends BaseTest {
  makeSureMutableFieldWorks (field) {
    field.validate()
    field.set(1)
    expect(field.get()).toBe(1)
    field.validate()
    field.set(2)
    expect(field.get()).toBe(2)
    field.validate()
  }

  testFieldMutableByDefault () {
    // Make sure fields are mutable by default && they can be mutated
    this.makeSureMutableFieldWorks(db.__private.NumberField({ optional: true }))
  }

  testMutableField () {
    // Make sure explicit mutable field works
    this.makeSureMutableFieldWorks(db.__private.NumberField({ optional: true }))
  }

  testInvalidFieldOption () {
    expect(() => {
      db.__private.NumberField({ aaaa: 1 }) // eslint-disable-line no-new
    }).toThrow(/unexpected option/)
  }

  testInvalidFieldName () {
    expect(() => {
      db.__private.__Field.__validateFieldOptions(
        'FakeModelName', undefined, '_nope', S.str)
    }).toThrow(/may not start with/)
  }

  testImmutableFieldNoDefault () {
    const field = db.__private.NumberField({
      immutable: true,
      optional: true,
      val: 1
    })
    field.validate()
    expect(field.get()).toBe(1)
    expect(() => {
      field.set(2)
    }).toThrow(db.InvalidFieldError)
    expect(() => {
      field.set(undefined)
    }).toThrow(db.InvalidFieldError)
  }

  testImmutableFieldWithDefault () {
    const field = db.__private.NumberField({ immutable: true, default: 1 })
    expect(() => {
      field.set(2)
    }).toThrow(db.InvalidFieldError)
    expect(() => {
      field.set(undefined)
    }).toThrow(db.InvalidFieldError)
  }

  testImmutableFieldWithUndefinedDefault () {
    const field = db.__private.NumberField({
      immutable: true,
      optional: true,
      val: 2
    })
    expect(field.get()).toBe(2)
    // cannot remove it once set, even though it's optional
    expect(() => {
      field.set(undefined)
    }).toThrow(db.InvalidFieldError)
  }

  get allFlags () {
    return ['immutable', 'default', 'isKey', 'optional']
  }

  testFlagsExist () {
    const field = db.__private.NumberField()
    this.allFlags.forEach(flag => {
      expect(Object.prototype.hasOwnProperty.call(field, flag)).toBe(true)
    })
  }

  testFlagsImmutable () {
    const field = db.__private.NumberField()
    this.allFlags.forEach(flag => {
      expect(() => {
        field[flag] = 1
      }).toThrow(TypeError)
    })
  }

  testMutatedFlagWithDefault () {
    // Fields with default are mutated by default also
    // so this field will be tranmitted to server on update
    const field = db.__private.NumberField({ default: 1, optional: true })
    expect(field.mutated).toBe(true)
    // The change should be committed in a read-write tx
    expect(field.hasChangesToCommit(true)).toBe(true)
    expect(field.hasChangesToCommit()).toBe(true)
    // The change should NOT be committed in a read-only tx
    expect(field.hasChangesToCommit(false)).toBe(false)

    // Setting field back to undefined makes it not mutated
    field.set(undefined)
    expect(field.mutated).toBe(false)
  }

  testMutatedFlagWithUndefinedDefault () {
    // Undefined values, shouldn't be mutated
    const field = db.__private.NumberField({ optional: true, val: undefined })
    expect(field.mutated).toBe(false)
  }

  testMutatedFlagNoDefault () {
    // Fields with no default aren't mutated after initialization
    let field = db.__private.NumberField({ optional: true, val: undefined })
    expect(field.mutated).toBe(false)

    // Public methods don't affect mutated flag except for `set`
    field.validate()
    expect(field.mutated).toBe(false)

    field.get()
    expect(field.mutated).toBe(false)

    // Setting to undefined should also make the field mutated
    field.set(1)
    expect(field.mutated).toBe(true)

    // Setting up a field makes it mutated
    // So read values from server will not be sent back on update
    field = db.__private.NumberField({ valIsFromDB: true, val: 1 })
    expect(field.mutated).toBe(false)
  }

  testMutatedFlagDetectsNestedChanges () {
    // Array and Object fields detects nested mutation correctly
    const deepobj = {}
    const arr = [{}, {}, deepobj]
    const arrSchema = S.arr(S.obj({ prop: S.int.optional() }))
    const arrayField = db.__private.ArrayField({
      valIsFromDB: true,
      val: arr,
      schema: arrSchema
    })
    expect(arrayField.mutated).toBe(false)

    const obj = { key: arr }
    const objectField = db.__private.ObjectField({
      valIsFromDB: true,
      val: obj,
      schema: S.obj({ key: arrSchema.copy().optional() })
    })
    expect(objectField.mutated).toBe(false)

    deepobj.prop = 1
    // Expected, since val from database should not change, so __mayHaveMutated
    // flag short-circuits the check
    expect(arrayField.mutated).toBe(false)
    expect(objectField.mutated).toBe(false)

    // Simply reading the field triggers mutated value change
    arrayField.get()
    objectField.get()
    expect(arrayField.mutated).toBe(true)
    expect(objectField.mutated).toBe(true)
  }

  testInitialValue () {
    // Initial value is default
    const field = db.__private.NumberField({ default: 1 })
    expect(field.__initialValue).toBe(undefined)

    field.set(2)
    expect(field.__initialValue).toBe(undefined)

    // Initial value is sync'd after setup
    const field2 = db.__private.NumberField({ valIsFromDB: true, val: 2 })
    expect(field2.__initialValue).toBe(2)
  }

  testHashKeyImmutable () {
    let field = db.__private.NumberField({ isKey: true })
    expect(field.immutable).toBe(true)

    expect(() => {
      db.__private.NumberField({ isKey: true, immutable: false })
    }).toThrow(db.InvalidOptionsError)

    field = db.__private.NumberField({ isKey: true, immutable: true })
    expect(field.immutable).toBe(true)
  }

  testKeyNoDefault () {
    const field = db.__private.NumberField({ isKey: true })
    expect(field.default).toBe(undefined)

    expect(() => {
      db.__private.NumberField({ isKey: true, default: 1 })
    }).toThrow(db.InvalidOptionsError)
  }

  testKeyRequired () {
    let field = db.__private.NumberField({ isKey: true })
    expect(field.optional).toBe(false)

    field = db.__private.NumberField({ isKey: true })
    expect(field.optional).toBe(false)

    expect(() => {
      db.__private.NumberField({ isKey: true, optional: true })
    }).toThrow(db.InvalidOptionsError)
    field = db.__private.NumberField({
      isKey: true,
      optional: undefined
    })
    expect(field.optional).toBe(false)
  }

  testRequiredFlag () {
    // Required w/o default
    expect(() => {
      db.__private.NumberField({ val: undefined })
    }).toThrow(db.InvalidFieldError)

    let field = db.__private.NumberField({ val: 0 })
    field.set(1)
    field.validate()

    // Required w/ default
    field = db.__private.NumberField({ default: 1 })
    field.validate()

    // Required w/ undefined as default. There's no point since the default is
    // already undefined. So we disallow this so there's only one right way
    // for the default value to be undefined.
    expect(() => {
      const opts = { default: undefined }
      db.__private.NumberField(opts) // eslint-disable-line no-new
    }).toThrow('Default value must be defined')
  }

  testAccessedFlag () {
    let field = db.__private.NumberField({ default: 1, optional: true })
    expect(field.accessed).toBe(false)

    field = db.__private.NumberField({ optional: true })
    expect(field.accessed).toBe(false)

    field.validate()
    expect(field.accessed).toBe(false)

    field.mutated // eslint-disable-line no-unused-expressions
    expect(field.accessed).toBe(false)

    field = db.__private.NumberField({ valIsFromDB: true, val: 1 })
    expect(field.accessed).toBe(false)

    field.get()
    expect(field.accessed).toBe(true)

    field = db.__private.NumberField()
    field.set(1)
    expect(field.accessed).toBe(true)
  }

  testInvalidValueReverts () {
    // When an invalid value is set to a field, an exception will be thrown.
    // But we need to make sure even if somehow the error is caught and ignored
    // the field remains valid.
    const field = db.__private.NumberField({ default: 987 })
    expect(() => {
      field.set('123')
    }).toThrow(S.ValidationError)
    expect(field.get()).toBe(987)
  }
}

class FieldSchemaTest extends BaseTest {
  testValidSchemaType () {
    db.__private.NumberField({ schema: S.double })
    db.__private.StringField({ schema: S.str })
    db.__private.ArrayField({ schema: S.arr() })
    db.__private.ObjectField({ schema: S.obj() })
  }

  testInvalidSchema () {
    // Make sure schema compilation is checked at field initilization time
    expect(() => {
      db.__private.NumberField({ schema: { oaisjdf: 'aosijdf' } })
    }).toThrow()
  }

  testInvalidDefault () {
    // Make sure default values are checked against schema
    expect(() => {
      db.__private.StringField({ schema: S.str.min(8), default: '123' })
    }).toThrow(S.ValidationError)
  }

  testStringValidation () {
    // Make sure string schema is checked
    const field = db.__private.StringField({
      val: '123456789',
      schema: S.str.min(8).max(9)
    })
    expect(() => {
      field.set('123')
    }).toThrow(S.ValidationError)

    field.set('12345678') // 8 char ok.

    expect(() => {
      field.set('1234567890') // 10 char not ok.
    }).toThrow(S.ValidationError)
  }

  testInvalidObject () {
    // Make sure object schema is checked
    const field = db.__private.ObjectField({
      val: { abc: 'x' },
      schema: S.obj().prop('abc', S.str)
    })

    const invalidValues = [
      {},
      { aaa: 123 },
      { abc: 123 }
    ]
    invalidValues.forEach(val => {
      expect(() => {
        field.set(val)
      }).toThrow(S.ValidationError)
    })
    field.set({ abc: '123' })
  }
}

class RepeatedFieldTest extends BaseTest {
  get fieldFactory () {
    throw new Error('Must be overridden')
  }

  get someGoodValue () {
    throw new Error('Must be overridden')
  }

  get valueType () {
    throw new Error('Must be overridden')
  }

  get values () {
    return ['a', 1, { a: 1 }, [1], true]
  }

  get valueSchema () {
    return undefined
  }

  testInvalidValueType () {
    const field = this.fieldFactory({ schema: this.valueSchema })
    this.values.forEach(val => {
      if (val.constructor.name === this.valueType.name) {
        field.set(val)
        expect(field.get()).toBe(val)
      } else {
        expect(() => {
          field.set(val)
        }).toThrow(S.ValidationError)
      }
    })
  }

  testNoDefaultValue () {
    const field = this.fieldFactory(({ optional: true, val: undefined }))
    expect(field.get()).toBeUndefined()
  }

  testDefaultValue () {
    this.values.forEach(val => {
      if (val.constructor.name === this.valueType.name) {
        const field = this.fieldFactory({
          default: val,
          schema: this.valueSchema
        })
        expect(field.get()).toStrictEqual(val)
      } else {
        expect(() => {
          this.fieldFactory({ default: val }) // eslint-disable-line no-new
        }).toThrow(S.ValidationError)
      }
    })
  }
}

class NumberFieldTest extends RepeatedFieldTest {
  get fieldFactory () {
    return db.__private.NumberField
  }

  get someGoodValue () { return 0 }

  get valueType () {
    return Number
  }

  testRequiredFlagWithFalsyValue () {
    this.fieldFactory({ default: 0 }).validate()
  }

  testImmutableFlagWithFalsyValue () {
    const field = this.fieldFactory({ immutable: true, default: 0 })
    expect(() => {
      field.set(1)
    }).toThrow(db.InvalidFieldError)
  }

  testIncrementByUndefined () {
    const field = db.__private.NumberField()
    field.incrementBy(123321)
    expect(field.get()).toBe(123321)
  }

  testIncrementByMultipleTimes () {
    function check (isNew) {
      const opts = isNew ? {} : { valIsFromDB: true, val: 0 }
      const field = db.__private.NumberField(opts)
      let expValue = 0
      const nums = [1, 123, 321]
      for (let i = 0; i < nums.length; i++) {
        const n = nums[i]
        expValue += n
        field.incrementBy(n)
      }
      expect(field.canUpdateWithIncrement).toBe(!isNew)
      expect(field.get()).toBe(expValue)
    }
    check(true)
    check(false)
  }

  testMixingSetAndIncrementBy () {
    let field = db.__private.NumberField()
    field.incrementBy(1)
    expect(() => {
      field.set(2)
    }).not.toThrow()
    expect(field.canUpdateWithIncrement).toBe(false)
    expect(field.get()).toBe(2)
    // we set the field without ever reading it, so we aren't conditioned on
    // its value

    field = db.__private.NumberField()
    field.set(1)
    expect(() => {
      field.incrementBy(1)
    }).not.toThrow()
    expect(field.canUpdateWithIncrement).toBe(false)
    expect(field.get()).toBe(2)
  }

  testDefaultThenIncrementBy () {
    const field = db.__private.NumberField({ default: 1 })
    expect(() => {
      field.incrementBy(1)
    }).not.toThrow()
  }

  testIncrementByMeta () {
    const field = db.__private.NumberField({ valIsFromDB: true, val: 0 })
    field.incrementBy(1)
    expect(field.accessed).toBe(true)
    expect(field.mutated).toBe(true)
  }

  testIncrementByImmutable () {
    const field = db.__private.NumberField({ immutable: true, val: 1 })
    expect(() => {
      field.incrementBy(2)
    }).toThrow()
  }

  testReadThenIncrementBy () {
    const field = db.__private.NumberField({ val: 0 })
    field.get()
    expect(() => {
      field.incrementBy(788)
    }).not.toThrow()
    expect(field.get()).toBe(788)
  }

  testIncrementByLockInitialUndefined () {
    // Make sure when a field's initial value is undefined (doesn't exists on
    // server), optimistic locking is still performed.
    const field = db.__private.NumberField({ optional: true, val: undefined })
    expect(() => field.incrementBy(788)).toThrow(
      'cannot increment a field whose value is undefined')
  }
}

class StringFieldTest extends RepeatedFieldTest {
  get fieldFactory () {
    return db.__private.StringField
  }

  get someGoodValue () { return 'ok' }

  get valueType () {
    return String
  }

  testRequiredFlagWithFalsyValue () {
    this.fieldFactory({ default: '' }).validate()
  }

  testImmutableFlagWithFalsyValue () {
    const field = this.fieldFactory({ immutable: true, default: '' })
    expect(() => {
      field.set('something')
    }).toThrow(db.InvalidFieldError)
  }
}

class ObjectFieldTest extends RepeatedFieldTest {
  get fieldFactory () {
    return db.__private.ObjectField
  }

  get someGoodValue () {
    return { a: 123 }
  }

  get valueType () {
    return Object
  }

  get valueSchema () {
    return S.obj({ a: S.int.optional() })
  }

  testDefaultDeepCopy () {
    const def = { a: { b: 1 } }
    const field = db.__private.ObjectField({
      default: def,
      schema: S.obj({
        a: S.obj({
          b: S.int
        })
      })
    })
    def.a.b = 2
    expect(field.get().a.b).toBe(1)
  }
}

class BooleanFieldTest extends RepeatedFieldTest {
  get fieldFactory () {
    return db.__private.BooleanField
  }

  get someGoodValue () { return true }

  get valueType () {
    return Boolean
  }

  testRequiredFlagWithFalsyValue () {
    this.fieldFactory({ default: false }).validate()
  }

  testImmutableFlagWithFalsyValue () {
    const field = this.fieldFactory({ immutable: true, default: false })
    expect(() => {
      field.set(true)
    }).toThrow(db.InvalidFieldError)
  }
}

class ArrayFieldTest extends RepeatedFieldTest {
  get fieldFactory () {
    return db.__private.ArrayField
  }

  get someGoodValue () { return [] }

  get valueType () {
    return Array
  }
}

class AbstractFieldTest extends BaseTest {
  testCreatingAbstractField () {
    // eslint-disable-next-line no-new
    expect(() => { new __FieldInterface() }).toThrow(Error)
  }

  testAbstractMethods () {
    class DummyCls extends __FieldInterface {}
    const obj = new DummyCls()
    expect(() => obj.mutated).toThrow(NotImplementedError)
    expect(() => obj.__mayHaveMutated).toThrow(NotImplementedError)
    expect(() => obj.accessed).toThrow(NotImplementedError)
    expect(() => obj.get()).toThrow(NotImplementedError)
    expect(() => obj.set('')).toThrow(NotImplementedError)
    expect(() => obj.__updateExpression('')).toThrow(NotImplementedError)
    expect(() => obj.validate()).toThrow(NotImplementedError)
    expect(() => obj.hasChangesToCommit()).toThrow(NotImplementedError)
  }
}

runTests(
  // Common
  CommonFieldTest,

  // Type specific
  ArrayFieldTest,
  BooleanFieldTest,
  NumberFieldTest,
  ObjectFieldTest,
  StringFieldTest,

  // Other
  FieldSchemaTest,
  AbstractFieldTest
)
