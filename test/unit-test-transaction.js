const assert = require('assert')

const S = require('@pocketgems/schema')
const { BaseTest, runTests } = require('@pocketgems/unit-test')
const uuidv4 = require('uuid').v4

const db = require('./db-with-field-maker')

async function txGetGeneric (cls, values, func) {
  return db.Context.run({ retries: 0 }, async tx => {
    let model
    const valuesType = values.constructor.name
    if (valuesType === 'Key' || valuesType === 'Data') {
      model = await tx.get(values, { createIfMissing: true })
    } else {
      model = await tx.get(cls, values, { createIfMissing: true })
    }
    if (func) {
      func(model)
    }
    return model
  })
}
async function txGet (keyValues, func) {
  return txGetGeneric(TransactionExample, keyValues, func)
}

async function txGetRequired (keyValues, func) {
  return txGetGeneric(TransactionExampleWithRequiredField, keyValues, func)
}

class TransactionExample extends db.Model {
  static KEY = { id: S.str.min(1) }
  static FIELDS = {
    field1: S.double.optional(),
    field2: S.double.optional(),
    arrField: S.arr(S.obj({ a: S.int.optional() })).optional(),
    objField: S.obj({
      a: S.obj({
        a: S.int.optional()
      }).optional()
    }).optional()
  }
}

class HookExample extends db.Model {
  static KEY = { id: S.str.min(1) }
  static FIELDS = {
    field1: S.int.default(0),
    latestUpdateEpoch: S.int.default(0)
      .desc('latest update epoch in milliseconds')
  }

  async finalize () {
    this.latestUpdateEpoch = Date.now()
  }
}

class TransactionExampleWithRequiredField extends TransactionExample {
  static FIELDS = { ...super.FIELDS, required: S.double }
}

class QuickTransactionTest extends BaseTest {
  mockTransactionDefaultOptions (options) {
    Object.defineProperty(db.Context.prototype, 'defaultOptions', {
      value: options
    })
  }

  async beforeAll () {
    await super.beforeAll()
    this.oldTransactionOptions = db.Context.prototype.defaultOptions
    const newOptions = Object.assign({}, this.oldTransactionOptions)
    Object.assign(newOptions, {
      readOnly: false,
      consistentReads: true,
      initialBackoff: 20,
      maxBackoff: 200,
      retries: 1,
      cacheModels: false
    })
    this.mockTransactionDefaultOptions(newOptions)
  }

  async afterAll () {
    super.afterAll()
    this.mockTransactionDefaultOptions(this.oldTransactionOptions)
  }
}

class ParameterTest extends BaseTest {
  testGoodOptions () {
    const badOptions = [
      { retries: 0 },
      { initialBackoff: 1 },
      { maxBackoff: 200 }
    ]
    for (const opt of badOptions) {
      expect(() => {
        new db.Context(opt) // eslint-disable-line no-new
      }).not.toThrow()
    }
  }

  testBadOptions () {
    const badOptions = [
      { retries: -1 },
      { initialBackoff: 0 },
      { maxBackoff: 199 },
      { notAValidOption: 1 },
      { retries: 'wrong type' }
    ]
    for (const opt of badOptions) {
      expect(() => {
        new db.Context(opt) // eslint-disable-line no-new
      }).toThrow(db.InvalidOptionsError)
    }
  }

  async testBadRunParam () {
    await expect(db.Context.run(1, 2)).rejects
      .toThrow(db.InvalidParameterError)

    await expect(db.Context.run({}, 2)).rejects
      .toThrow(db.InvalidParameterError)

    await expect(db.Context.run(1, () => {})).rejects
      .toThrow(db.InvalidParameterError)

    await expect(db.Context.run(1, 2, 3)).rejects
      .toThrow(db.InvalidParameterError)
  }
}

class KeyOnlyExample extends db.Model {
  static KEY = { id: S.str.min(1) }
}

class KeyOnlyExample2 extends KeyOnlyExample {
  static collectionName = KeyOnlyExample.collectionName // same
}

class TransactionEdgeCaseTest extends BaseTest {
  async afterEach () {
    jest.restoreAllMocks()
  }

  async testKeyCollisionFromSeparateModels () {
    const id = uuidv4()
    let checked = false
    const promise = db.Context.run(async tx => {
      const i1 = tx.create(KeyOnlyExample, { id })
      await db.Context.run(tx => {
        const i2 = tx.create(KeyOnlyExample2, { id })
        expect(i1.toString()).toEqual(i2.toString())
        checked = true
      })
    })
    await expect(promise).rejects.toThrow(db.ModelAlreadyExistsError)
    expect(checked).toBe(true)
  }
}

class TransactionGetTest extends QuickTransactionTest {
  async beforeAll () {
    await super.beforeAll()
    this.modelName = uuidv4()
    await txGet(this.modelName)
  }

  async testGetDocTwice () {
    await db.Context.run(async (tx) => {
      await tx.get(TransactionExample, 'a',
        { createIfMissing: true })
      const fut = tx.get(TransactionExample, 'a',
        { createIfMissing: true })
      await expect(fut).rejects
        .toThrow('Model tracked twice')
    })
  }

  async testGetModelByID () {
    await db.Context.run(async (tx) => {
      const model = await tx.get(TransactionExample, 'a',
        { createIfMissing: true })
      expect(model.id).toBe('a')
    })
  }

  async testGetModelByKey () {
    await db.Context.run(async (tx) => {
      const model = await tx.get(TransactionExample.data('a'),
        { createIfMissing: true })
      expect(model.id).toBe('a')
    })
  }

  async testGetModelByKeys () {
    await db.Context.run(async (tx) => {
      const [m1, m2] = await tx.get([
        TransactionExample.data('a'),
        TransactionExample.data('b')
      ], { createIfMissing: true })
      expect(m1.id).toBe('a')
      expect(m2.id).toBe('b')
    })
  }

  async testTransactGet () {
    const ids = [uuidv4(), uuidv4()]
    // create them
    await txGet(ids[0])
    await txGet(ids[1])
    const [m1, m2] = await db.Context.run(async (ctx) => {
      const ret = await ctx.get([
        TransactionExample.key(ids[0]),
        TransactionExample.key(ids[1])
      ])
      expect(ctx.__trackedModelsList.length).toBe(2)
      return ret
    })
    expect(m1.id).toBe(ids[0])
    expect(m2.id).toBe(ids[1])
  }

  async testMultipleGet () {
    await db.Context.run(async (tx) => {
      const [m1, m2] = await tx.get([
        TransactionExample.data('a'),
        TransactionExample.data('b')
      ], { createIfMissing: true })
      const m3 = await tx.get(TransactionExample, 'c', { createIfMissing: true })
      const m4 = await tx.get(TransactionExample.data('d'),
        { createIfMissing: true })
      expect(m1.id).toBe('a')
      expect(m2.id).toBe('b')
      expect(m3.id).toBe('c')
      expect(m4.id).toBe('d')
    })
  }

  async testGetWithParams () {
    const params = { createIfMissing: true }
    await db.Context.run(async (tx) => {
      const [m1, m2] = await tx.get([
        TransactionExample.data('a'),
        TransactionExample.data('b')
      ], params)
      const m3 = await tx.get(TransactionExample, 'c', params)
      const m4 = await tx.get(TransactionExample.data('d'), params)
      const m5 = await tx.get(TransactionExample.key('e'))
      expect(m1.id).toBe('a')
      expect(m2.id).toBe('b')
      expect(m3.id).toBe('c')
      expect(m4.id).toBe('d')
      expect(m5).toBe(undefined)
    })
    await db.Context.run(async tx => {
      const m4NoCreateIfMissing = await tx.get(TransactionExample.key('d'))
      expect(m4NoCreateIfMissing.id).toBe('d')
      const m5 = await tx.get(TransactionExample.key('e'))
      expect(m5).toBe(undefined)
    })
  }

  async testGetMissingThenCreateNoCache () {
    let id = uuidv4()
    const fut1 = db.Context.run({ cacheModels: false }, async tx => {
      const m1 = await tx.get(TransactionExample, id)
      const m2 = await tx.get(TransactionExample, id, { createIfMissing: true })
      return [m1, m2]
    })
    await expect(fut1).rejects.toThrow('Model tracked twice')

    // okay to create after get which found nothing
    id = uuidv4()
    const fut2 = db.Context.run(async tx => {
      await tx.get(TransactionExample, id)
      tx.create(TransactionExample, { id })
    })
    await expect(fut2).resolves.not.toThrow()
  }

  async testGetMissingThenCreateCached () {
    let id = uuidv4()
    const ret = await db.Context.run({ cacheModels: true }, async tx => {
      const m1 = await tx.get(TransactionExample, id)
      const m2 = await tx.get(TransactionExample, id, { createIfMissing: true })
      return [m1, m2]
    })
    expect(ret[0]).toBe(undefined)
    expect(ret[1]._id).toBe(id)

    id = uuidv4()
    const fut = db.Context.run(async tx => {
      await tx.get(TransactionExample, id)
      tx.create(TransactionExample, { id })
    })
    await expect(fut).resolves.not.toThrow()
  }
}

class TransactionWriteTest extends QuickTransactionTest {
  async beforeAll () {
    await super.beforeAll()
    this.modelName = '1234'
    await txGet(this.modelName, model => {
      model.field1 = 0
      model.field2 = 0
    })
  }

  async testWriteExisting () {
    const val = Math.floor(Math.random() * 999999)
    const data = TransactionExample.data(this.modelName)
    await db.Context.run(async (tx) => {
      const txModel = await tx.get(data, { createIfMissing: true })
      txModel.field1 = val
      txModel.field2 = 200
    })
    const model = await txGet(data)
    expect(model.field1).toBe(val)
  }

  async testWriteNew () {
    const modelName = uuidv4()
    const data = TransactionExample.data(modelName)
    const val = Math.floor(Math.random() * 999999)
    await db.Context.run(async (tx) => {
      const txModel = await tx.get(data, { createIfMissing: true })
      expect(txModel.isNew).toBe(true)
      txModel.field1 = val
    })
    const model = await txGet(data)
    expect(model.isNew).toBe(false)
    expect(model.field1).toBe(val)
  }

  async testWriteFinalizeHook () {
    const modelName = uuidv4()
    let fakeTime = 1000
    jest.spyOn(Date, 'now').mockImplementation(
      () => fakeTime
    )
    const data = HookExample.data(modelName)
    await db.Context.run(async tx => {
      const txModel = await tx.get(data, { createIfMissing: true })
      txModel.field1 = 22
    })
    fakeTime = 2000
    let model = await txGet(data)
    expect(model.latestUpdateEpoch).toEqual(1000)

    await db.Context.run(async tx => {
      const txModel = await tx.get(data, { createIfMissing: true })
      txModel.field1 = 23
    })
    model = await txGet(data)
    expect(model.latestUpdateEpoch).toEqual(2000)
  }

  async testMultipleCreateErrors () {
    const id1 = uuidv4()
    const id2 = uuidv4()
    function createBoth (tx) {
      tx.create(TransactionExample, { id: id1 })
      tx.create(TransactionExample, { id: id2 })
    }
    await db.Context.run(createBoth)
    expect((await txGet(id1)).id).toBe(id1)
    expect((await txGet(id2)).id).toBe(id2)
    try {
      // try to create both of them again
      await db.Context.run(createBoth)
      assert.fail('should not get here')
    } catch (err) {
      // error will only report the first issue encountered
      expect(err.message).toMatch(/Tried to recreate an existing model/)
    }
  }

  async testCreateWithData () {
    const name = uuidv4()
    await db.Context.run(tx => {
      const model = tx.create(TransactionExample, { id: name, field1: 987 })
      model.field2 = 1
    })
    const model = await txGet(name)
    expect(model.field1).toBe(987)
  }

  async testWriteExistingAsNew () {
    const val = Math.floor(Math.random() * 999999)
    let tryCnt = 0
    const fut = db.Context.run({ retries: 3 }, async (tx) => {
      tryCnt++
      const txModel = tx.create(TransactionExample, { id: this.modelName })
      txModel.field1 = val
    })
    await expect(fut).rejects.toThrow(db.ModelAlreadyExistsError)
    expect(tryCnt).toBe(1) // non-retryable error so only 1 attempt should've been made
  }

  async testReadContention () {
    // When updating, if properties read in a transaction was updated outside,
    // contention!
    const id = uuidv4()
    const data = TransactionExample.data(id)
    const ret = await db.Context.run({ retries: 0 }, async (tx) => {
      // this acquires a lock on the doc
      const txModel = await tx.get(data, { createIfMissing: true })

      // because of the lock, this will fail and field2 will remain undefined
      try {
        await txGet(data, model => {
          model.field2 = 321
        })
      } catch (e) {
        expect(e.message).toContain('Transaction lock timeout')
      }

      txModel.field1 = 123
      return true
    })
    expect(ret).toBe(true)
    await db.verifyDoc(TransactionExample, id, { field1: 123, field2: undefined })
  }

  async testWriteContention () {
    // When updating, if properties change in a transaction was also updated
    // outside, contention!
    const data = TransactionExample.data(this.modelName)
    const mOrig = await txGet(data)
    const field2Orig = mOrig.field2
    const fut = db.Context.run({ retries: 0 }, async (tx) => {
      // this locks the model
      const txModel = await tx.get(data, { createIfMissing: true })

      // so this fails
      await txGet(data, model => {
        model.field2 = 99
      })

      // so we never reach this
      txModel.field2 = 111
      txModel.field1 = 123
    })
    await expect(fut).rejects.toThrow(db.TransactionFailedError)
    const m = await txGet(data)
    expect(m.field2).toBe(field2Orig)
  }

  async testWriteSnapshot () {
    // Additional changes to model after call to update should not be reflected
    const data = TransactionExample.data(uuidv4())
    const deepObj = { a: 12 }
    await db.Context.run(async tx => {
      const model = await tx.get(data, { createIfMissing: true })
      expect(model.isNew).toBe(true)

      model.arrField = [deepObj]
      model.objField = { a: deepObj }
    })
    deepObj.a = 32
    const updated = await txGet(data)
    expect(updated.objField.a.a).toBe(12)
    expect(updated.arrField[0].a).toBe(12)
  }

  async testCreateAndThenOverwriteWithCreateOrOverwrite () {
    // create something new
    const id = uuidv4()
    await db.verifyDoc(TransactionExample, id) // does not exist yet
    await db.Context.run(async tx => {
      tx.createOrOverwrite(TransactionExample,
        { id: id, field1: 3, field2: 1 })
    })
    await db.verifyDoc(TransactionExample, id, { field1: 3, field2: 1 })

    // can overwrite (this is an overwrite, not a merge!)
    await db.Context.run(async tx => {
      tx.createOrOverwrite(TransactionExample,
        { id, field1: 4, objField: { a: { a: 1 } } })
    })
    await db.Context.run(async tx => {
      const doc = await tx.get(TransactionExample, id)
      expect(doc.id).toBe(id)
      expect(doc.field1).toBe(4)
      expect(doc.field2).toBe(undefined)
      expect(doc.objField).toEqual({ a: { a: 1 } })
    })
  }

  async testUpdateDocNonExisting () {
    const id = 'nonexistent' + uuidv4()
    let fut = db.Context.run(async tx => {
      return tx.updateWithoutRead(TransactionExample, { id, field1: 2 })
    })
    await expect(fut).rejects.toThrow(Error)

    fut = db.Context.run(async tx => {
      tx.createOrOverwrite(TransactionExampleWithRequiredField,
        { id, field1: 3, field2: 1 })
    })
    await expect(fut).rejects.toThrow(/missing required value/)

    await db.Context.run(async tx => {
      tx.createOrOverwrite(TransactionExample,
        { id, field1: 3, field2: 1, arrField: undefined, objField: undefined })
    })
    let model = await txGet(id)
    expect(model.field1).toBe(3)

    await db.Context.run(async tx => {
      tx.createOrOverwrite(TransactionExample,
        {
          id,
          field1: 3,
          field2: 567,
          arrField: undefined,
          objField: undefined
        }
      )
    })
    model = await txGet(id)
    expect(model.field2).toBe(567)
  }

  async testUpdateNoReturn () {
    // UpdateDoc should not return the model for further modifications
    await db.Context.run(async tx => {
      const ret = await tx.updateWithoutRead(TransactionExample,
        { id: this.modelName, field1: 2 })
      expect(ret).toBe(undefined)
    })
  }

  async testUpdateDoc () {
    const data = TransactionExample.data(this.modelName)
    const origModel = await txGet(data)
    const newVal = Math.floor(Math.random() * 9999999)
    await db.Context.run(async tx => {
      const original = {}
      Object.keys(TransactionExample._attrs).forEach(fieldName => {
        const val = origModel[fieldName]
        if (val !== undefined) {
          original[fieldName] = val
        }
      })
      await tx.updateWithoutRead(data.Cls, { ...original, field1: newVal })
    })
    const updated = await txGet(data)
    expect(updated.field1).toBe(newVal)
  }

  async testUpdateWithNoChange () {
    const fut = db.Context.run(async tx => {
      await tx.updateWithoutRead(
        TransactionExample,
        { id: this.modelName })
    })
    await expect(fut).rejects.toThrow('update did not provide any data to change')
  }

  async testUpdateOtherFields () {
    await txGet(this.modelName, (m) => { m.field2 = 2 })
    await db.Context.run(async tx => {
      await tx.updateWithoutRead(
        TransactionExample,
        { id: this.modelName, field1: 1 })
    })
    const model = await txGet(this.modelName)
    expect(model.field1).toBe(1)
  }

  async testDeleteFieldByUpdate () {
    await txGet(this.modelName, (m) => { m.field2 = 2 })
    await db.Context.run(async tx => {
      await tx.updateWithoutRead(
        TransactionExample,
        { id: this.modelName, field2: undefined })
    })
    const model = await txGet(this.modelName)
    expect(model.field2).toBe(undefined)
    expect(model._field1_field2).toBe(undefined)
  }

  async testCreatePartialModel () {
    let fut = db.Context.run(async tx => {
      tx.createOrOverwrite(
        TransactionExampleWithRequiredField,
        {
          id: this.modelName,
          field1: 1,
          field2: 2,
          arrField: undefined,
          objField: undefined
        }
      )
    })
    await expect(fut).rejects.toThrow(/missing required value/)

    fut = db.Context.run(async tx => {
      tx.createOrOverwrite(
        TransactionExampleWithRequiredField,
        {
          id: this.modelName,
          field1: 1,
          field2: 2,
          arrField: undefined,
          objField: undefined,
          required: undefined
        }
      )
    })
    await expect(fut).rejects.toThrow(/missing required value/)

    await db.Context.run(async tx => {
      tx.createOrOverwrite(
        TransactionExampleWithRequiredField,
        {
          id: this.modelName,
          field1: 111222,
          field2: undefined,
          arrField: undefined,
          objField: undefined,
          required: 333444
        }
      )
    })
    const model = await txGetRequired(this.modelName)
    expect(model.field1).toBe(111222)
    expect(model.required).toBe(333444)
  }

  async testCreateNewModel () {
    // New model should work without conditions
    let name = uuidv4()
    await db.Context.run(async tx => {
      tx.createOrOverwrite(
        TransactionExample,
        {
          id: name,
          field1: 333222,
          field2: undefined,
          arrField: undefined,
          objField: undefined
        }
      )
    })
    let model = await txGet(name)
    expect(model.field1).toBe(333222)

    // New model should work with conditions too
    name = uuidv4()
    await db.Context.run(async tx => {
      tx.createOrOverwrite(
        TransactionExample,
        {
          id: name,
          field1: 123123,
          field2: undefined,
          arrField: undefined,
          objField: undefined
        }
      )
    })
    model = await txGet(name)
    expect(model.field1).toBe(123123)
  }

  async testConditionalPut () {
    const name = uuidv4()
    await db.Context.run(async tx => {
      tx.createOrOverwrite(
        TransactionExample,
        {
          id: name,
          field1: 9988234,
          field2: undefined,
          arrField: undefined,
          objField: undefined
        }
      )
    })
    const model = await txGet(name)
    expect(model.field1).toBe(9988234)
  }

  async testTransactionalCreateOrOverwrite () {
    const ids = [uuidv4(), uuidv4()]
    const helper = async (value) => {
      await db.Context.run(async tx => {
        for (const id of ids) {
          tx.createOrOverwrite(
            TransactionExample,
            {
              id,
              field1: value,
              field2: 111,
              arrField: undefined,
              objField: undefined
            }
          )
        }
      })
      for (const id of ids) {
        const model = await txGet(id)
        expect(model).toBeDefined()
        expect(model.field1).toBe(value)
      }
    }
    await helper(1)
    await helper(2)
  }

  async testUpdatePartialModel () {
    // Make sure only fields to be updated are validated.
    const modelName = uuidv4()
    const fut = txGetRequired({ id: modelName })
    await expect(fut).rejects.toThrow() // Missing required field, should fail

    const data = { id: modelName, required: 1, field1: 1 }
    await txGetRequired(data)
    const newVal = Math.floor(Math.random() * 99999999)
    await db.Context.run(async tx => {
      await tx.updateWithoutRead(
        TransactionExampleWithRequiredField,
        { id: modelName, field1: newVal })
    })
    const updated = await txGetRequired({ id: modelName })
    expect(updated.field1).toBe(newVal)
  }

  async testEmptyUpdate () {
    const fut = db.Context.run(async tx => {
      await tx.updateWithoutRead(
        TransactionExample,
        { id: '123' })
    })
    await expect(fut).rejects.toThrow('update did not provide any data to change')
  }

  // Verify model cannot be tracked more than once inside a tx.
  async testDuplicateTracking () {
    // verify create then get on non existing doc fails
    const id = uuidv4()
    await txGet(id) // make the doc first
    const future = db.Context.run(async tx => {
      tx.createOrOverwrite(TransactionExample, { id, field1: 1 })
      await tx.get(TransactionExample, { id })
    })
    await expect(future)
      .rejects
      .toThrow(/Model tracked twice/)

    // verify delete after get is okay
    const id2 = uuidv4()
    await db.Context.run(async tx => {
      await tx.get(TransactionExample, id2)
      await tx.delete(TransactionExample.key({ id: id2 }))
    })
    await db.verifyDoc(TransactionExample, id2)
  }

  async testGetAfterWrite () {
    const id = uuidv4()
    const future = db.Context.run(async tx => {
      await tx.delete(TransactionExample.key({ id }))
      await tx.get(TransactionExample, { id: id + 'x' }) // a different model
    })
    await expect(future)
      .rejects
      .toThrow(/Firestore transactions require all reads to be executed before all writes/)
  }
}

class TransactionReadOnlyTest extends QuickTransactionTest {
  async testReadOnlyOption () {
    await expect(db.Context.run({ readOnly: true }, async tx => {
      tx.create(TransactionExample, { id: uuidv4() })
    })).rejects.toThrow('read-only')
  }

  async testMakeReadOnlyDuringTx () {
    await expect(db.Context.run(async tx => {
      tx.makeReadOnly()
      await tx.updateWithoutRead(TransactionExample, { id: uuidv4(), field1: 1 })
    })).rejects.toThrow('read-only')
  }

  async testDelete () {
    await expect(db.Context.run(async tx => {
      tx.makeReadOnly()
      await tx.delete(TransactionExample.key({ id: uuidv4() }))
    })).rejects.toThrow(/in a read-only transaction/)
  }

  async testDefaultValueBehavior () {
    const ModelToUpdate = class extends db.Model {
      static KEY = { id: S.str.min(1) }
      static FIELDS = {
        field1: S.int
      }
    }
    const id = uuidv4()
    // create a entry using the old schema
    await db.Context.run(async (tx) => {
      await tx.create(ModelToUpdate, { id, field1: 1 })
    })
    await db.Context.run(async (tx) => {
      tx.makeReadOnly()
      const model = await tx.get(ModelToUpdate, { id })
      expect(model.field1).toBe(1)
    })

    // Update the schema to add a required field with default value
    ModelToUpdate.FIELDS = {
      ...ModelToUpdate.FIELDS,
      field2: S.int.default(0)
    }
    delete ModelToUpdate.__createdResource
    delete ModelToUpdate.__setupDone
    delete ModelToUpdate.__CACHED_SCHEMA

    // Retrieve the old data, the field2 is assigned the default value,
    // but this change will NOT be committed
    await db.Context.run(async (tx) => {
      tx.makeReadOnly()
      const model = await tx.get(ModelToUpdate, { id })
      expect(model.field1).toBe(1)
      expect(model.field2).toBe(0)
    })

    // Tx will still fail if the value is set explicitly
    await expect(db.Context.run(async tx => {
      tx.makeReadOnly()
      const model = await tx.get(ModelToUpdate, { id })
      expect(model.field2).toBe(0)
      model.field2 = 0
    })).rejects.toThrow('read-only')
  }
}

class TransactionRetryTest extends QuickTransactionTest {
  async expectRetries (err, maxRetries, expectedRuns) {
    let cnt = 0
    const fut = db.Context.run({ retries: maxRetries }, () => {
      cnt++
      throw err
    })
    await expect(fut).rejects.toThrow(Error)
    expect(cnt).toBe(expectedRuns)
  }

  async testRetryableErrors () {
    let err = new Error('something')
    await this.expectRetries(err, 0, 1)
    await this.expectRetries(err, 2, 1)

    err.retryable = true
    await this.expectRetries(err, 2, 3)

    // error 10 (lock contention) should be retried
    err = new Error('fake')
    err.code = 10
    err.details = 'fake firestore lock error'
    await this.expectRetries(err, 1, 2)

    // error 6 (create failed because doc already exists) should not be retried
    err.code = 6
    err.details = 'fake firestore error'
    // this error requires an Element
    err.message = 'random gook Element { type: "X"\n name: "Y"\n } random stuff'
    await this.expectRetries(err, 3, 1)

    // non-error 6 with Element returns the error as is (no retries)
    err.code = 66
    await this.expectRetries(err, 3, 1)

    // error 6 with invalid Element returns the error as is
    err.code = 6
    err.message = 'Element { wrong thing: "X"\n name: "Y"\n }'
    await this.expectRetries(err, 3, 1)
    err.message = 'Elt { type: "X"\n name: "Y"\n }'
    await this.expectRetries(err, 3, 1)
    err.message = 'Element { type: "X"\n name: "Y"'
    await this.expectRetries(err, 3, 1)
    err.message = 'Element { type: "X" name: "" }' // missing name
    await this.expectRetries(err, 3, 1)
  }

  testIsRetryableErrors () {
    const err = new Error()
    expect(db.Context.__isRetryable(err)).toBe(false)

    err.name = 'TransactionCanceledException'
    expect(db.Context.__isRetryable(err)).toBe(false)

    err.code = 'TransactionCanceledException'
    expect(db.Context.__isRetryable(err)).toBe(false)

    err.code = 6
    err.details = 'xx'
    expect(db.Context.__isRetryable(err)).toBe(false)

    err.retryable = true
    expect(db.Context.__isRetryable(err)).toBe(true)
  }
}

class TransactionDeleteTest extends QuickTransactionTest {
  async getNoCreate (id) {
    return db.Context.run(tx => {
      return tx.get(TransactionExample, id)
    })
  }

  async testDeleteParams () {
    const result = await db.Context.run(async tx => {
      const m1 = await tx.get(TransactionExample, uuidv4(),
        { createIfMissing: true })
      const m2 = await tx.get(TransactionExample, uuidv4(),
        { createIfMissing: true })
      const m3 = TransactionExample.key({ id: uuidv4() })

      await tx.delete(m1, m2, m3) // fine

      await expect(async () => {
        await tx.delete(123)
      }).rejects.toThrow('Invalid parameter args. Must be models and keys.')

      return 1122331
    })
    expect(result).toBe(1122331) // Proof that tx ran
  }

  async testDeleteModel () {
    const m = await txGet(uuidv4())
    const key = TransactionExample.key({ id: m.id })
    const result = await db.Context.run(async tx => {
      const model = await tx.get(key)
      await tx.delete(model)
      return model
    })
    expect(result.id).toBe(m.id)
    expect(await this.getNoCreate(m.id)).toBeUndefined()
  }

  async testTxDeleteModel () {
    const m = await txGet(uuidv4())
    const key = TransactionExample.key({ id: m.id })
    const result = await db.Context.run(async tx => {
      // multiple docs goes through TransactWrite
      await tx.get(TransactionExample, uuidv4(), { createIfMissing: true })
      const model = await tx.get(key)
      await tx.delete(model)
      return model
    })
    expect(result.id).toBe(m.id)
    expect(await this.getNoCreate(m.id)).toBeUndefined()
  }

  async testDeleteNonExisting () {
    // Deleting an doc that we don't know if exists should silently pass
    const data = TransactionExample.data({ id: uuidv4() })
    await db.Context.run(async tx => {
      await tx.delete(data)
    })

    await db.Context.run(async tx => {
      // create then delete in the same transaction don't cause conflicts
      const model = await tx.get(data, { createIfMissing: true })
      await tx.delete(model)
    })

    await db.Context.run(async tx => {
      // create then delete in the same transaction don't cause conflicts
      const model = tx.create(data.Cls, data.keyComponents)
      await tx.delete(model)
    })
  }

  async testMissingRequired () {
    // Deleting using key should work even when the model has required fields
    await db.Context.run({ retries: 0 }, async tx => {
      await tx.delete(TransactionExampleWithRequiredField.key({ id: uuidv4() }))
    })
  }

  async testDoubleDeletion () {
    const id = uuidv4()
    await expect(db.Context.run({ retries: 0 }, async tx => {
      await tx.delete(TransactionExample.key({ id }))
      await tx.delete(TransactionExample.key({ id }))
    })).rejects.toThrow('Tried to delete model twice')
  }
}

class TransactionCacheModelsTest extends BaseTest {
  async testGetOne () {
    const id = uuidv4()
    const ret = await db.Context.run({ cacheModels: true }, async tx => {
      const m1 = await tx.get(TransactionExample, id, { createIfMissing: true })
      const m2 = await tx.get(TransactionExample, id)
      return [m1, m2]
    })
    expect(ret[0]._id).toBe(ret[1]._id)
  }

  async testGetMissing () {
    const id = uuidv4()
    const ret = await db.Context.run({ cacheModels: true }, async tx => {
      const m1 = await tx.get(TransactionExample, id)
      // Repeatedly getting a missing doc should also work
      const m2 = await tx.get(TransactionExample, id)
      const m3 = await tx.get(TransactionExample, id, { createIfMissing: true })
      // this will get the created model from m3
      const m4 = await tx.get(TransactionExample, id)
      return [m1, m2, m3, m4]
    })
    expect(ret[0]).toBe(undefined)
    expect(ret[1]).toBe(undefined)
    expect(ret[2]._id).toBe(id)
    expect(ret[3]._id).toBe(id)
  }

  async testGetMany () {
    const id = uuidv4()
    const ret = await db.Context.run(async tx => {
      tx.enableModelCache()
      const opts = { createIfMissing: true }
      const m2 = await tx.get(TransactionExample, id, opts)
      const ms = await tx.get([
        TransactionExample.data({ id: uuidv4() }),
        TransactionExample.data({ id })
      ], opts)
      return [ms[1], m2]
    })
    expect(ret[0]._id).toBe(ret[1]._id)
  }

  async testGetDeleteGet () {
    const id = uuidv4()
    const fut = db.Context.run({ cacheModels: true }, async tx => {
      const opts = { createIfMissing: true }
      const model = await tx.get(TransactionExample.data({ id }), opts)
      await tx.delete(model)
      return await tx.get(TransactionExample.key({ id }))
    })
    const ret = await fut
    await expect(ret).toBe(null)
  }

  async testGetAfterDelete () {
    const id = uuidv4()
    const fut = db.Context.run({ cacheModels: true }, async tx => {
      const opts = { createIfMissing: true }
      await tx.delete(TransactionExample.key({ id }))
      return await tx.get(TransactionExample, id, opts)
    })
    const ret = await fut
    expect(ret).toBe(null)
  }

  async testPutModels () {
    // Models created with createOrOverwrite cannot be read and modified afterwards
    const id = uuidv4()
    const ret = await db.Context.run({ cacheModels: true }, async tx => {
      tx.createOrOverwrite(TransactionExample,
        { id, field1: 3 }
      )
      // not a model tracked twice error because we set cacheModels to true
      return await tx.get(TransactionExample.key({ id }))
    })
    expect(ret.field1).toBe(3)
  }

  async testPersistedChanges () {
    const id = uuidv4()
    const { model, model2 } = await db.Context.run({ cacheModels: true }, async tx => {
      const model = await tx.get(TransactionExample.data({ id }),
        { createIfMissing: true })
      model.field1 = 1.1
      const model2 = await tx.get(TransactionExample.key({ id }))
      return { model, model2 }
    })
    expect(model).toBe(model2)
    expect(model2.field1).toBe(1.1)
  }
}

class ModelDiffsTest extends BaseTest {
  get defaultExpectation () {
    return {
      TransactionExample: {
        _id: undefined,
        data: {
          _id: undefined,
          field1: undefined,
          field2: undefined,
          arrField: undefined,
          objField: undefined
        }
      }
    }
  }

  async testNonexistent () {
    const id = uuidv4()
    const result = await db.Context.run(async tx => {
      await tx.get(TransactionExample, id)
      return tx.getModelDiffs()
    })
    expect(result.before).toStrictEqual([])
    expect(result.after).toStrictEqual([])
  }

  async testGet () {
    const id = uuidv4()
    const result = await db.Context.run(async tx => {
      const m = await tx.get(TransactionExample, id, { createIfMissing: true })
      m.field1 = 321
      return tx.getModelDiffs()
    })
    const expectation = this.defaultExpectation
    expectation.TransactionExample._id = id
    expect(result.before[0]).toStrictEqual(expectation)

    expectation.TransactionExample.data._id = id
    expectation.TransactionExample.data.field1 = 321
    expect(result.after[0]).toStrictEqual(expectation)
  }

  async __helperTestGet (func) {
    const ids = [uuidv4(), uuidv4()]
    const result = await db.Context.run(async tx => {
      await func(tx, ids)
      return tx.getModelDiffs()
    })

    // confirm _ids appropriately added for before/after snapshots.
    const expectedModels = [this.defaultExpectation, this.defaultExpectation]
    expectedModels[0].TransactionExample._id = ids[0]
    expectedModels[1].TransactionExample._id = ids[1]
    expect(result.before.length).toEqual(2)
    expect(result.before).toEqual(expect.arrayContaining(expectedModels))

    expectedModels[0].TransactionExample.data._id = ids[0]
    expectedModels[1].TransactionExample.data._id = ids[1]
    expect(result.after.length).toEqual(2)
    expect(result.after).toEqual(expect.arrayContaining(expectedModels))

    // verify that no additional properties were included/excluded.
    for (const entry of [...result.before, ...result.after]) {
      // already validated _id, so we can safely set.
      entry.TransactionExample._id = undefined
      entry.TransactionExample.data._id = undefined
      expect(entry).toStrictEqual(this.defaultExpectation)
    }
  }

  async testMultipleGets () {
    await this.__helperTestGet(async (tx, ids) => {
      return Promise.all(ids.map(id => {
        return tx.get(TransactionExample, id, { createIfMissing: true })
      }))
    })
  }

  async testDelete () {
    const id = uuidv4()
    // Blind delete
    const result = await db.Context.run(async tx => {
      await tx.delete(TransactionExample.key({ id }))
      return tx.getModelDiffs()
    })
    const expectation = this.defaultExpectation
    expectation.TransactionExample._id = id
    expect(result).toStrictEqual({
      before: [],
      after: [],
      diff: []
    })

    // Create model
    await db.Context.run(async tx => {
      await tx.get(TransactionExample, { id, field1: 1 },
        { createIfMissing: true })
    })
    const result2 = await db.Context.run(async tx => {
      const m = await tx.get(TransactionExample, id)
      await tx.delete(m)
      return tx.getModelDiffs()
    })
    expectation.TransactionExample.data._id = id
    expectation.TransactionExample.data.field1 = 1
    expect(result2).toStrictEqual({
      before: [],
      after: [],
      diff: []
    })
  }

  async testTransactGet () {
    await this.__helperTestGet(async (tx, ids) => {
      return tx.get(ids.map(id => TransactionExample.data({ id })),
        { createIfMissing: true })
    })
  }
}

class WithoutTransactionTest extends BaseTest {
  async testMutateOutsideTx () {
    const id = uuidv4()
    await db.Context.run(async tx => {
      await tx.get(TransactionExample, { id, field1: 1 }, { createIfMissing: true })
    })
    await db.verifyDoc(TransactionExample, id, { field1: 1 })

    // test delete
    await db.Context.run({ readOnly: true, consistentReads: false }, async ctx => {
      // hacky allow writes outside tx (not recommended, but possible)
      ctx.options.readOnly = false
      await ctx.delete(TransactionExample.key(id))
      await ctx.__saveChangedModels()
    })
    await db.verifyDoc(TransactionExample, id)

    // test create outside tx
    await db.Context.run({ readOnly: true, consistentReads: false }, async ctx => {
      ctx.options.readOnly = false
      ctx.create(TransactionExample, { id, field1: 2 })
      await ctx.__saveChangedModels()
    })
    console.log('check create')
    await db.verifyDoc(TransactionExample, id, { field1: 2 })
    console.log('p2')

    // test update outside tx
    await db.Context.run({ readOnly: true, consistentReads: false }, async ctx => {
      ctx.options.readOnly = false
      await ctx.updateWithoutRead(TransactionExample, { id, field1: 3 })
      await ctx.__saveChangedModels()
    })
    await db.verifyDoc(TransactionExample, id, { field1: 3 })

    // test create or overwrite tx
    await db.Context.run({ readOnly: true, consistentReads: false }, async ctx => {
      ctx.options.readOnly = false
      ctx.createOrOverwrite(TransactionExample, { id, field1: 4 })
      await ctx.__saveChangedModels()
    })
    await db.verifyDoc(TransactionExample, id, { field1: 4 })
    await db.Context.run({ readOnly: true, consistentReads: false }, async ctx => {
      ctx.options.readOnly = false
      ctx.createOrOverwrite(TransactionExample, { id: id + 'x', field2: 5 })
      await ctx.__saveChangedModels()
    })
    await db.verifyDoc(TransactionExample, id + 'x', { field2: 5 })
  }
}

class LeftoverContextTest extends BaseTest {
  async testInvalidOptions () {
    const badOpts = { readOnly: false, consistentReads: false }
    await expect(db.Context.run(badOpts, ctx => {})).rejects.toThrow('consistentReads')
  }

  async testCannotTrackModelTwiceWithoutCache () {
    const id = uuidv4()
    await expect(db.Context.run(async ctx => {
      await ctx.createOrOverwrite(TransactionExample, { id })
      await ctx.createOrOverwrite(TransactionExample, { id })
    })).rejects.toThrow('Model tracked twice')
  }
}

runTests(
  ParameterTest,
  TransactionDeleteTest,
  TransactionEdgeCaseTest,
  TransactionGetTest,
  TransactionReadOnlyTest,
  TransactionRetryTest,
  TransactionWriteTest,
  TransactionCacheModelsTest,
  LeftoverContextTest,
  ModelDiffsTest,
  WithoutTransactionTest
)
