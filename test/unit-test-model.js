const { FieldValue } = require('@google-cloud/firestore')
const S = require('@pocketgems/schema')
const { BaseTest, runTests } = require('@pocketgems/unit-test')
const uuidv4 = require('uuid').v4

const { Context } = require('../src/context')

const db = require('./db-with-field-maker')

class BadModelTest extends BaseTest {
  check (cls, msg) {
    expect(() => cls.__doOneTimeModelPrep()).toThrow(msg)
  }

  testMissingPrimaryKey () {
    class BadExample extends db.Model {
      static KEY = {}
    }
    this.check(BadExample, /at least one partition key field/)
    class BadModel2 extends db.Model {
      static KEY = null
    }
    this.check(BadModel2, /partition key is required/)
  }

  testDuplicateField () {
    const expMsg = /more than once/
    class BadExample extends db.Model {
      static KEY = { name: S.str }
      static FIELDS = { name: S.str }
    }
    this.check(BadExample, expMsg)
  }

  testReservedName () {
    class BadExample extends db.Model {
      static KEY = { isNew: S.str }
    }
    this.check(BadExample, /field name is reserved/)

    class BadModel2 extends db.Model {
      static KEY = { getField: S.str }
    }
    this.check(BadModel2, /shadows a property name/)
  }

  testIDName () {
    class PartitionKeyMustProvideNamesExample extends db.Model {
      static KEY = S.double
    }
    this.check(PartitionKeyMustProvideNamesExample, /must define key component name/)

    class OkExample extends db.Model {
      static KEY = { id: S.str }
    }
    OkExample.__doOneTimeModelPrep()

    class IDCanBePartOfACompoundPartitionKey extends db.Model {
      static KEY = { id: S.str, n: S.double }
    }
    IDCanBePartOfACompoundPartitionKey.__doOneTimeModelPrep()

    class IDDoesNotHaveToBeAString extends db.Model {
      static KEY = { id: S.double }
    }
    IDDoesNotHaveToBeAString.__doOneTimeModelPrep()

    class IDCanBeAFieldName extends db.Model {
      static KEY = { x: S.double }
      static FIELDS = { id: S.str }
    }
    IDCanBeAFieldName.__doOneTimeModelPrep()
  }
}

class ErrorTest extends BaseTest {
  testInvalidFieldError () {
    const err = new db.InvalidFieldError('testField', 'test error')
    expect(err.message).toBe('testField test error')
  }

  testTransactionFailedError () {
    const innerErr = new Error('some error')
    let txErr = new db.TransactionFailedError(innerErr)
    expect(txErr.stack.includes(innerErr.stack))
    expect(txErr.message).toBe('Error: some error')

    txErr = new db.TransactionFailedError('new error')
    expect(txErr.message).toBe('new error')
  }
}

async function txGet (key, id, func) {
  return db.Context.run(async tx => {
    const model = await tx.get(key, id, { createIfMissing: true })
    if (func) {
      func(model)
    }
    return model
  })
}

async function txGetByKey (key, func) {
  return db.Context.run(async tx => {
    const model = await tx.get(key, { createIfMissing: true })
    if (func) {
      func(model)
    }
    return model
  })
}

async function txCreate (...args) {
  return db.Context.run(tx => {
    return tx.create(...args)
  })
}

class SimpleExample extends db.Model {}
SimpleExample.__doOneTimeModelPrep()

class SimpleExampleTest extends BaseTest {
  testNamingConvention () {
    expect(() => {
      class SomeModel extends db.Model {}
      SomeModel.__validateTableName() // eslint-disable-line
    }).toThrow(/not include "Model"/)
    expect(() => {
      class SomeTable extends db.Model {}
      SomeTable.__validateTableName() // eslint-disable-line
    }).toThrow(/not include "Table"/)
  }

  async testFieldNotExtendable () {
    await expect(db.Context.run(tx => {
      const row = tx.create(SimpleExample, { id: uuidv4() })
      row.id.weCannotAddPropertiesToFieldsOnModels = undefined
    })).rejects.toThrow(TypeError)
  }

  async testDebugFunctionExport () {
    // Only export in debugging
    jest.resetModules()
    const oldVal = process.env.INDEBUGGER
    process.env.INDEBUGGER = 0
    const tempDB = require('../src/default-db')
    expect(tempDB.Model.__private).toBe(undefined)
    process.env.INDEBUGGER = oldVal
    jest.resetModules()
  }

  async testWriteModel () {
    const name = uuidv4()
    await txCreate(SimpleExample, { id: name })
    expect((await txGet(SimpleExample, name)).id).toBe(name)
  }

  async testNoExtension () {
    const model = await txGet(SimpleExample, uuidv4())
    expect(() => {
      model.someProp = 1
    }).toThrow()
  }

  async testIdImmutable () {
    const model = await txGet(SimpleExample, uuidv4())
    expect(() => {
      model.id = 'someThingElse'
    }).toThrow()
  }
}

class NewModelTest extends BaseTest {
  async testCreateModelIsNew () {
    const result = await db.Context.run(tx => {
      const id = uuidv4()
      const model = tx.create(SimpleExample, { id })
      expect(model.id).toBe(id)
      expect(model.id).toBe(SimpleExample.__encodeCompoundValue(
        SimpleExample.__keyOrder, { id }))
      expect(model.isNew).toBe(true)
      tx.__reset() // Don't write anything, cause it will fail.
      return 321
    })
    expect(result).toBe(321) // Make sure it's done
  }

  async testGetNewModel () {
    let ret = await db.Context.run(async tx => {
      return tx.get(SimpleExample, uuidv4())
    })
    expect(ret).toBe(undefined)

    ret = await db.Context.run(async tx => {
      return tx.get(SimpleExample, uuidv4(), { createIfMissing: true })
    })
    expect(ret).not.toBe(undefined)
  }

  async testNewModelWriteCondition () {
    const id = uuidv4()
    await txCreate(SimpleExample, { id })
    await expect(txCreate(SimpleExample, { id }))
      .rejects.toThrow(
        `Tried to recreate an existing model: SimpleExample _id=${id}`)
  }

  async testNewModelParamsDeprecated () {
    const id = uuidv4()
    const model = await txCreate(SimpleExample, { id })
    expect(model.id).toBe(id)
    expect(model.params).toStrictEqual(undefined)
  }
}

class IDWithSchemaExample extends db.Model {
  static KEY = {
    id: S.str.pattern(/^xyz.*$/).desc(
      'any string that starts with the prefix "xyz"')
  }
}

class CompoundIDExample extends db.Model {
  static KEY = {
    year: S.int.min(1900),
    make: S.str.min(3),
    upc: S.str
  }
}

class ObjKeyExample extends db.Model {
  static KEY = {
    obj: S.obj({
      innerInt: S.int,
      innerStr: S.str
    })
  }
}

class IntKeyExample extends db.Model {
  static KEY = {
    id: S.int
  }
}

class IDSchemaTest extends BaseTest {
  async testSimpleIDWithSchema () {
    const cls = IDWithSchemaExample
    const id = 'xyz' + uuidv4()
    const m1 = await txCreate(cls, { id })
    expect(m1.id).toBe(id)
    await expect(txCreate(cls, { id: 'bad' })).rejects.toThrow(
      S.ValidationError)

    // IDs are checked when keys are created too
    expect(() => cls.key('bad')).toThrow(S.ValidationError)
    const keyOrder = cls.__keyOrder
    expect(() => cls.__encodeCompoundValue(keyOrder, { id: 'X' }))
      .toThrow(S.ValidationError)
    expect(cls.key('xyz').encodedKey).toEqual('xyz')
    expect(cls.__encodeCompoundValue(keyOrder, { id: 'xyz' }))
      .toEqual('xyz')
  }

  async testCompoundID () {
    const compoundID = { year: 1900, make: 'Honda', upc: uuidv4() }
    const keyOrder = CompoundIDExample.__keyOrder
    const id = CompoundIDExample.__encodeCompoundValue(
      keyOrder, compoundID)
    function check (entity) {
      expect(entity._id).toBe(id)
      expect(entity.year).toBe(1900)
      expect(entity.make).toBe('Honda')
      expect(entity.upc).toBe(compoundID.upc)
    }

    check(await txCreate(CompoundIDExample, compoundID))
    check(await txGetByKey(CompoundIDExample.data(compoundID)))
    check(await txGet(CompoundIDExample, compoundID))

    expect(() => CompoundIDExample.key({})).toThrow(db.InvalidFieldError)
    expect(() => CompoundIDExample.key({
      year: undefined, // not allowed!
      make: 'Toyota',
      upc: 'nope'
    })).toThrow(db.InvalidFieldError)
    expect(() => CompoundIDExample.key({
      year: 2020,
      make: 'Toy\0ta', // no null bytes!
      upc: 'nope'
    })).toThrow(db.InvalidFieldError)
    expect(() => CompoundIDExample.key({
      year: 2040,
      make: 'need upc too'
    })).toThrow(db.InvalidFieldError)

    const msg = /incorrect number of components/
    expect(() => CompoundIDExample.__decodeCompoundValue(
      keyOrder, '', 'fake')).toThrow(msg)
    expect(() => CompoundIDExample.__decodeCompoundValue(
      keyOrder, id + '\0', 'fake')).toThrow(msg)
    expect(() => CompoundIDExample.__decodeCompoundValue(
      keyOrder, '\0' + id, 'fake')).toThrow(msg)

    expect(() => CompoundIDExample.key('unexpected value')).toThrow(
      db.InvalidParameterError)
  }

  async testObjKeyStableEncoding () {
    const keyOrder = ObjKeyExample.__keyOrder
    const key1 = ObjKeyExample.__encodeCompoundValue(keyOrder,
      {
        obj: {
          innerInt: 10,
          innerStr: 'xyz'
        }
      }
    )
    const key2 = ObjKeyExample.__encodeCompoundValue(keyOrder,
      {
        obj: {
          innerStr: 'xyz',
          innerInt: 10
        }
      }
    )
    expect(key1).toStrictEqual(key2)
  }

  async testIntKey () {
    const key = IntKeyExample.__encodeCompoundValue(
      IntKeyExample.__keyOrder, { id: 2342 }, true)
    expect(key).toBe(2342)

    const decoded = IntKeyExample.__decodeCompoundValue(
      IntKeyExample.__keyOrder, 2, '_test', true)
    expect(decoded).toEqual({ id: 2 })
  }
}

class BasicExample extends db.Model {
  static FIELDS = {
    noRequiredNoDefault: S.double.optional()
  }
}

class WriteTest extends BaseTest {
  async beforeAll () {
    this.modelName = uuidv4()
    await txGet(BasicExample, this.modelName, model => {
      model.noRequiredNoDefault = 0
    })
  }

  async testNoIDInUpdateCondition () {
    const m1 = await txGet(BasicExample, this.modelName)
    expect(db.checkWriteCall(m1)).toEqual({ update: {} })
  }

  async testWriteSetToUndefinedProp () {
    // If a field is set to undefined when it's already undefined,
    // the prop should not be transmitted.
    const id = uuidv4()
    const model = await txGet(BasicExample, id)
    expect(model.isNew).toBe(true)
    expect(model.noRequiredNoDefault).toBe(undefined)
    model.noRequiredNoDefault = undefined

    db.verifyDoc(BasicExample, id, {})
  }

  async testResettingProp () {
    // If a field is set to some value then set to undefined again,
    // the change should be handled correctly
    let model = await txGet(BasicExample, uuidv4(), model => {
      expect(model.isNew).toBe(true)
      expect(model.noRequiredNoDefault).toBe(undefined)
      model.noRequiredNoDefault = 1
    })

    // Reset the prop to undefined should delete it
    model = await txGet(BasicExample, model.id, model => {
      expect(model.noRequiredNoDefault).toBe(1)
      model.noRequiredNoDefault = undefined
    })

    // Read and check again
    model = await txGet(BasicExample, model.id)
    expect(model.noRequiredNoDefault).toBe(undefined)
  }

  async testPutNoLock () {
    const model = await txGet(BasicExample, this.modelName)
    model.getField('noRequiredNoDefault').incrementBy(1)
    expect(db.checkWriteCall(model)).toEqual(
      { update: { noRequiredNoDefault: FieldValue.increment(1) } })
  }

  async testRetry () {
    let count = 0
    await expect(Context.run(tx => {
      count += 1
      const err = new Error('testing max retries')
      err.retryable = true
      throw err
    })).rejects.toThrow(/out of retries/)
    expect(count).toBe(5)
  }
}

class ConditionCheckTest extends BaseTest {
  async beforeAll () {
    this.modelName = uuidv4()
    await txGet(BasicExample, this.modelName)
  }

  async testNewModel () {
    const m1 = await txGet(BasicExample, uuidv4())
    expect(m1.isNew).toBe(true)
    expect(m1.__isMutated()).toBe(true)
  }

  async testMutatedModel () {
    const m1 = await txGet(BasicExample, this.modelName)
    expect(m1.__isMutated()).toBe(false)
    m1.noRequiredNoDefault = 1 + (m1.noRequiredNoDefault ?? 0)
    expect(m1.__isMutated()).toBe(true)
  }

  async testConditionCheckMutatedModel () {
    const m1 = await txGet(BasicExample, this.modelName)
    m1.noRequiredNoDefault = 1 + (m1.noRequiredNoDefault ?? 0)
    expect(() => {
      m1.__conditionCheckParams()
    }).toThrow()
  }

  async testConditionCheckUnchangedModel () {
    const m1 = await txGet(BasicExample, this.modelName)
    expect(m1.__conditionCheckParams().ConditionExpression)
      .toBe('attribute_exists(#_id)')
  }

  async testReadonlyModel () {
    const m1 = await txGet(BasicExample, this.modelName)
    m1.noRequiredNoDefault // eslint-disable-line no-unused-expressions
    const awsName = m1.getField('noRequiredNoDefault').__awsName
    expect(m1.__conditionCheckParams()).toHaveProperty('ConditionExpression',
      `attribute_exists(#_id) AND attribute_not_exists(${awsName})`)
  }
}

class OneFieldExample extends db.Model {
  static FIELDS = {
    n: S.int
  }
}

class KeyTest extends BaseTest {
  async testGetNoCreateIfMissingWithExcessFields () {
    const fut = db.Context.run(async tx => {
      // can't specify field like "n" when reading unless we're doing a
      // createIfMissing=true
      await tx.get(OneFieldExample, { id: uuidv4(), n: 3 })
    })
    await expect(fut).rejects.toThrow(/received non-key fields/)
  }

  testDataKey () {
    const id = uuidv4()
    const data = OneFieldExample.data({ id, n: 5 })
    const key = data.key
    expect(key.keyComponents.id).toBe(id)
    expect(data.data.n).toBe(5)
  }

  async testGetWithWrongType () {
    await expect(db.Context.run(async tx => {
      await tx.get(OneFieldExample.key({ id: uuidv4() }), {
        createIfMissing: true
      })
    })).rejects.toThrow(/must pass a Data/)

    await expect(db.Context.run(async tx => {
      await tx.get(OneFieldExample.data({ id: uuidv4(), n: 3 }))
    })).rejects.toThrow(/must pass a Key/)
  }

  async testValidKey () {
    SimpleExample.key(uuidv4())
    SimpleExample.key({ id: uuidv4() })
  }

  async testInvalidKey () {
    const id = uuidv4()
    const invalidIDsForSimpleExample = [
      // these aren't even valid IDs
      1,
      '',
      String(''),
      undefined,
      {},
      [],
      { id, abc: 123 }
    ]
    for (const keyValues of invalidIDsForSimpleExample) {
      expect(() => {
        SimpleExample.key(keyValues)
      }).toThrow()
    }
  }

  testDeprecatingLegacySyntax () {
    expect(() => {
      SimpleExample.key('id', 123)
    }).toThrow()
  }
}

class JSONExample extends db.Model {
  static FIELDS = {
    objNoDefaultNoRequired: S.obj().optional(),
    objDefaultNoRequired: S.obj({
      a: S.int
    }).default({ a: 1 }).optional(),
    objNoDefaultRequired: S.obj({
      ab: S.int.optional(),
      cd: S.arr(S.int).optional()
    }),
    objDefaultRequired: S.obj().default({}),
    arrNoDefaultNoRequired: S.arr().optional(),
    arrDefaultNoRequired: S.arr().default([1, 2]).optional(),
    arrNoDefaultRequired: S.arr(S.obj({
      cd: S.int.optional(),
      bc: S.int.optional()
    })),
    arrDefaultRequired: S.arr().default([])
  }
}

class IndexJsonExample extends db.Model {
  static KEY = {
    key1: S.str,
    key2: S.str
  }

  static FIELDS = {
    data: S.str
  }
}

class JSONExampleTest extends BaseTest {
  async testRequiredFields () {
    const obj = { ab: 2 }
    const arr = [{ cd: 2 }, { cd: 1 }]
    async function check (input) {
      input.id = uuidv4()
      await expect(txGet(JSONExample, input)).rejects.toThrow(
        /missing required value/)
    }
    await check({})
    await check({ objNoDefaultRequired: obj })
    await check({ arrNoDefaultRequired: arr })

    const id = uuidv4()
    async function checkOk (input) {
      const model = await txGet(JSONExample, input)
      expect(model.id).toBe(id)
      expect(model.objNoDefaultRequired).toEqual(obj)
      expect(model.arrNoDefaultRequired).toEqual(arr)
      expect(model.objNoDefaultNoRequired).toBe(undefined)
      expect(model.arrNoDefaultNoRequired).toBe(undefined)
      expect(model.objDefaultNoRequired).toEqual({ a: 1 })
      expect(model.arrDefaultNoRequired).toEqual([1, 2])
      expect(model.objDefaultRequired).toEqual({})
      expect(model.arrDefaultRequired).toEqual([])
    }
    await checkOk({ id, objNoDefaultRequired: obj, arrNoDefaultRequired: arr })
    await checkOk({ id }) // just getting, not creating
  }

  async testDeepUpdate () {
    const obj = { cd: [] }
    const arr = [{}]
    const id = uuidv4()
    const data = { id, objNoDefaultRequired: obj, arrNoDefaultRequired: arr }
    await txGet(JSONExample, data, model => {
      expect(model.isNew).toBe(true)
    })

    await txGet(JSONExample, id, model => {
      obj.cd.push(1)
      model.objNoDefaultRequired.cd.push(1)
      arr[0].bc = 32
      model.arrNoDefaultRequired[0].bc = 32
    })

    await txGet(JSONExample, id, model => {
      expect(model.objNoDefaultRequired).toStrictEqual(obj)
      expect(model.arrNoDefaultRequired).toStrictEqual(arr)
    })
  }

  async testToJson () {
    const id = uuidv4()
    const data = {
      id,
      objNoDefaultNoRequired: {},
      objDefaultNoRequired: { a: 1 },
      objNoDefaultRequired: { ab: 12, cd: [23] },
      objDefaultRequired: { a: '2' },
      arrDefaultNoRequired: [2, 3],
      arrNoDefaultRequired: [{ cd: 2 }],
      arrDefaultRequired: []
    }
    const [model1, model2] = await db.Context.run(async tx => {
      return [
        await tx.get(JSONExample, data, { createIfMissing: true }),
        await tx.get(IndexJsonExample, { key1: '1', key2: '2', data: '3' },
          { createIfMissing: true })
      ]
    })
    expect(model1.toJSON()).toEqual(data)
    expect(model2.toJSON()).toEqual({ key1: '1', key2: '2', data: '3' })
  }
}

class GetArgsParserTest extends BaseTest {
  async testJustAModel () {
    await expect(db.__private.getWithArgs([SimpleExample], () => {})).rejects
      .toThrow(db.InvalidParameterError)
  }

  async testNoArg () {
    const invalidArgs = [undefined, {}, [], 1, '']
    for (const args of invalidArgs) {
      await expect(db.__private.getWithArgs(args, () => {})).rejects
        .toThrow(db.InvalidParameterError)
    }
  }

  async testId () {
    const params = [SimpleExample]
    await expect(db.__private.getWithArgs(params, () => {})).rejects
      .toThrow(db.InvalidParameterError)

    params.push(uuidv4())
    await expect(async () => {
      const result = await db.__private.getWithArgs(params, () => 123)
      expect(result).toBe(123)
    }).not.toThrow()

    params.push({})
    await expect(async () => {
      const result = await db.__private.getWithArgs(params, () => 234)
      expect(result).toBe(234)
    }).not.toThrow()

    params[1] = { id: uuidv4() }
    await expect(async () => {
      const result = await db.__private.getWithArgs(params, () => 23)
      expect(result).toBe(23)
    }).not.toThrow()

    params.push(1)
    await expect(db.__private.getWithArgs(params, () => {})).rejects
      .toThrow(db.InvalidParameterError)
  }

  async testKey () {
    const params = [SimpleExample.key(uuidv4())]
    expect(async () => {
      const result = await db.__private.getWithArgs(params, () => 123)
      expect(result).toBe(123)
    }).not.toThrow()

    params.push({})
    expect(async () => {
      const result = await db.__private.getWithArgs(params, () => 234)
      expect(result).toBe(234)
    }).not.toThrow()

    params.push(1)
    await expect(db.__private.getWithArgs(params, () => {})).rejects
      .toThrow(db.InvalidParameterError)
  }

  async testKeys () {
    const keys = []
    const params = [keys]
    await expect(db.__private.getWithArgs(params)).rejects
      .toThrow(db.InvalidParameterError)

    const id1 = uuidv4()
    const id2 = uuidv4()
    keys.push(SimpleExample.key(id1), SimpleExample.key(id2))
    const result = await db.__private.getWithArgs(params,
      (keys) => keys.map(key => key.encodedKey))
    expect(result).toStrictEqual([{ _id: id1 }, { _id: id2 }])

    keys.push(1)
    await expect(db.__private.getWithArgs(params)).rejects
      .toThrow(db.InvalidParameterError)

    keys.splice(2, 1)
    params.push({})
    const result1 = await db.__private.getWithArgs(params,
      (keys) => keys.map(key => key.encodedKey))
    expect(result1).toStrictEqual([{ _id: id1 }, { _id: id2 }])

    params.push(1)
    await expect(db.__private.getWithArgs(params)).rejects
      .toThrow(db.InvalidParameterError)
  }
}

class DefaultsTest extends BaseTest {
  /**
   * Verify that nested defaults are applied
   * to saved models
   */
  async testNestedDefaultsOnSave () {
    class NestedDefaultsExample extends db.Model {
      static FIELDS = {
        arr: S.arr(S.obj({
          int: S.int,
          str: S.str.default('butterfly')
        })),
        obj: S.obj({
          int: S.int.default(2),
          str: S.str.default('shoe')
        }).default({})
      }
    }
    const id = uuidv4()

    await db.Context.run(async tx => {
      tx.create(NestedDefaultsExample, {
        id: id,
        arr: [{ int: 2 }, { int: 3 }]
      })
    })

    await db.Context.run(async tx => {
      const result = await tx.get(NestedDefaultsExample, id)
      expect(result.arr).toEqual([
        {
          int: 2,
          str: 'butterfly'
        },
        {
          int: 3,
          str: 'butterfly'
        }
      ])

      // obj defaults should be applied top-down
      expect(result.obj).toEqual({
        int: 2,
        str: 'shoe'
      })
    })
  }

  /**
   * Verify that nested defaults are applied
   * when retrieving models
   */
  async testNestedDefaultsOnGet () {
    const fields = {
      arr: S.arr(S.obj({
        int: S.int,
        str: S.str.default('butterfly')
      }))
    }

    class NestedDefaultsExample extends db.Model {
      static FIELDS = fields
    }

    const id = uuidv4()

    await db.Context.run(async tx => {
      tx.create(NestedDefaultsExample, {
        id: id,
        arr: [{ int: 2 }, { int: 3 }]
      })
    })

    fields.arr.itemsSchema.__isLocked = false
    fields.arr.itemsSchema.prop('newField', S.str.default('newDefault'))
    delete NestedDefaultsExample.__setupDone
    NestedDefaultsExample.__doOneTimeModelPrep()

    await db.Context.run(async tx => {
      const result = await tx.get(NestedDefaultsExample, id)
      expect(result.arr).toEqual([
        {
          int: 2,
          str: 'butterfly',
          newField: 'newDefault'
        },
        {
          int: 3,
          str: 'butterfly',
          newField: 'newDefault'
        }
      ])
    })
  }
}

class OptDefaultExampleTest extends BaseTest {
  async testFieldWhichIsBothOptionalAndDefault () {
    class OptDefaultExample extends db.Model {
      static get FIELDS () {
        return {
          def: S.int.default(7),
          opt: S.int.optional(),
          defOpt: S.int.default(7).optional()
        }
      }
    }

    function check (obj, def, opt, defOpt, def2, opt2, defOpt2) {
      expect(obj.def).toBe(def)
      expect(obj.opt).toBe(opt)
      expect(obj.defOpt).toBe(defOpt)
      if (def2) {
        expect(obj.def2).toBe(def2)
        expect(obj.opt2).toBe(opt2)
        expect(obj.defOpt2).toBe(defOpt2)
      }
    }

    const idSpecifyNothing = uuidv4()
    const idSpecifyAll = uuidv4()
    const idUndef = uuidv4()
    await db.Context.run(tx => {
      // can just use the defaults (specify no field values)
      check(tx.create(OptDefaultExample, { id: idSpecifyNothing }),
        7, undefined, 7)

      // can use our own values (specify all field values)
      check(tx.create(OptDefaultExample, {
        id: idSpecifyAll,
        def: 1,
        opt: 2,
        defOpt: 3
      }), 1, 2, 3)

      // optional fields with a default can still be omitted from the db (i.e.,
      // assigned a value of undefined)
      check(tx.create(OptDefaultExample, {
        id: idUndef,
        defOpt: undefined
      }), 7, undefined, undefined)
    })

    // verify that these are all properly stored to the database
    await db.Context.run(async tx => {
      check(await tx.get(OptDefaultExample, idSpecifyNothing), 7, undefined, 7)
      check(await tx.get(OptDefaultExample, idSpecifyAll), 1, 2, 3)
      check(await tx.get(OptDefaultExample, idUndef), 7, undefined, undefined)
    })

    // add a new set of fields (normally we'd do this on the same model, but
    // for the test we do it in a new model (but SAME TABLE) because one-time
    // setup is already done for the other model)
    class OptDefaultExample2 extends db.Model {
      static tableName = OptDefaultExample.name
      static FIELDS = {
        ...OptDefaultExample.FIELDS,
        def2: S.int.default(8),
        opt2: S.int.optional(),
        defOpt2: S.int.default(8).optional()
      }
    }

    // the default value for new fields isn't stored in the db yet (old rows
    // have not been changed yet)
    let fut = db.Context.run(async tx => {
      await tx.update(OptDefaultExample2,
        { id: idSpecifyNothing, def2: 8 }, { def: 1 })
    })
    await expect(fut).rejects.toThrow(/outdated \/ invalid conditions/)

    // we can (ONLY) use update() on defaults that have been written to the db
    await db.Context.run(async tx => {
      await tx.update(OptDefaultExample2,
        { id: idSpecifyNothing, def: 7 }, { opt2: 11 })
    })

    // blind updates are only partial, so they won't populate a new default
    // field unless explicitly given a value for it
    fut = db.Context.run(async tx => {
      await tx.update(OptDefaultExample2,
        { id: idSpecifyNothing, def2: 8 }, { def: 2 })
    })
    await expect(fut).rejects.toThrow(/outdated \/ invalid conditions/)

    // verify that these are all in the proper state when accessing old rows;
    // also, accessing the row populates the default value for the new field
    // which triggers a database write!
    await db.Context.run(async tx => {
      check(await tx.get(OptDefaultExample2, idSpecifyNothing),
        7, undefined, 7,
        8, 11, undefined)
    })
    await db.Context.run(async tx => {
      // verify the db was updated by doing a blind update dependent on it
      await tx.update(OptDefaultExample2,
        { id: idSpecifyNothing, def2: 8 }, { def: 100 })
    })
    await db.Context.run(async tx => {
      check(await tx.get(OptDefaultExample2, idSpecifyNothing),
        100, undefined, 7, 8, 11, undefined)
    })

    // accessing and modifying an old row will also write the new defaults to
    // the db
    await db.Context.run(async tx => {
      const row = await tx.get(OptDefaultExample2, idUndef)
      check(row, 7, undefined, undefined,
        8, undefined, undefined)
      row.def = 3
    })
    await db.Context.run(async tx => {
      // verify the db was updated by doing a blind update dependent on it
      await tx.update(OptDefaultExample2,
        { id: idUndef, def: 3, def2: 8 }, { opt2: 101 })
    })
    await db.Context.run(async tx => {
      check(await tx.get(OptDefaultExample2, idUndef),
        3, undefined, undefined, 8, 101, undefined)
    })
  }
}

class SnapshotTest extends BaseTest {
  async beforeAll () {
    await super.beforeAll()
    this.modelID = uuidv4()
    await db.Context.run(async tx => {
      await tx.get(JSONExample, {
        id: this.modelID,
        objNoDefaultRequired: { ab: 11 },
        arrNoDefaultRequired: []
      }, { createIfMissing: true })
    })
  }

  async testGetNewModel () {
    const id = uuidv4()
    const result = await db.Context.run(async tx => {
      const m = await tx.get(JSONExample,
        {
          id,
          objNoDefaultRequired: { ab: 123 },
          arrNoDefaultRequired: [{ cd: 12 }]
        },
        { createIfMissing: true })
      expect(m.getField('arrNoDefaultNoRequired').accessed).toBe(false)
      const data = {
        before: m.getSnapshot({ initial: true, dbKeys: true }),
        after: m.getSnapshot({ dbKeys: true })
      }
      // getSnapshot should not mark fields as accessed so optimistic lock in
      // TX is not affected.
      expect(m.getField('arrNoDefaultNoRequired').accessed).toBe(false)
      return data
    })
    expect(result).toStrictEqual({
      before: {
        _id: undefined,
        arrDefaultNoRequired: undefined,
        arrDefaultRequired: undefined,
        arrNoDefaultNoRequired: undefined,
        arrNoDefaultRequired: undefined,
        objDefaultNoRequired: undefined,
        objDefaultRequired: undefined,
        objNoDefaultNoRequired: undefined,
        objNoDefaultRequired: undefined
      },
      after: {
        _id: id,
        arrDefaultNoRequired: [1, 2],
        arrDefaultRequired: [],
        arrNoDefaultNoRequired: undefined,
        arrNoDefaultRequired: [{ cd: 12 }],
        objDefaultNoRequired: { a: 1 },
        objDefaultRequired: {},
        objNoDefaultNoRequired: undefined,
        objNoDefaultRequired: { ab: 123 }
      }
    })
  }

  async testGetExistingModel () {
    const result = await db.Context.run(async tx => {
      const m = await tx.get(JSONExample, this.modelID)
      return {
        before: m.getSnapshot({ initial: true, dbKeys: true }),
        after: m.getSnapshot({ dbKeys: true })
      }
    })
    const expectation = {
      _id: this.modelID,
      arrDefaultNoRequired: [1, 2],
      arrDefaultRequired: [],
      arrNoDefaultNoRequired: undefined,
      arrNoDefaultRequired: [],
      objDefaultNoRequired: { a: 1 },
      objDefaultRequired: {},
      objNoDefaultNoRequired: undefined,
      objNoDefaultRequired: { ab: 11 }
    }
    expect(result.before).toStrictEqual(expectation)
    expect(result.after).toStrictEqual(expectation)
  }
}

class UniqueKeyListTest extends BaseTest {
  testDedup () {
    const id = uuidv4()
    const keys = new db.UniqueKeyList(SimpleExample.key(id))
    keys.push(SimpleExample.key(id), SimpleExample.key(uuidv4()))
    expect(keys.length).toBe(2)
    keys.push(SimpleExample.key(id))
    expect(keys.length).toBe(2)
  }

  async testGet () {
    const id = uuidv4()
    await db.Context.run(tx => {
      tx.create(SimpleExample, { id })
    })
    const keys = new db.UniqueKeyList(SimpleExample.key(id))
    const result = await db.Context.run(tx => {
      return tx.get(keys)
    })
    expect(result[0].id).toBe(id)
  }
}

runTests(
  BadModelTest,
  ConditionCheckTest,
  DefaultsTest,
  ErrorTest,
  GetArgsParserTest,
  IDSchemaTest,
  JSONExampleTest,
  KeyTest,
  NewModelTest,
  OptDefaultExampleTest,
  SimpleExampleTest,
  SnapshotTest,
  WriteTest,
  UniqueKeyListTest
)
