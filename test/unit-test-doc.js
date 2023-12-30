const S = require('@pocketgems/schema')
const { BaseTest, runTests } = require('@pocketgems/unit-test')
const uuidv4 = require('uuid').v4

const db = require('../src/default-db')

class OrderWithNoPrice extends db.Model {
  static FIELDS = {
    product: S.str,
    quantity: S.int
  }
}

class OrderWithPrice extends db.Model {
  static FIELDS = {
    quantity: S.int,
    unitPrice: S.int.desc('price per unit in cents')
  }

  totalPrice (salesTax = 0.1) {
    const subTotal = this.quantity * this.unitPrice
    return subTotal * (1 + salesTax)
  }
}

class RaceResult extends db.Model {
  static KEY = {
    raceID: S.int,
    runnerName: S.str
  }
}

class ModelWithFieldsExample extends db.Model {
  static FIELDS = {
    someInt: S.int.min(0),
    someBool: S.bool,
    someObj: S.obj().prop('arr', S.arr(S.str))
  }
}

class ComplexFieldsExample extends db.Model {
  static FIELDS = {
    aNonNegInt: S.int.min(0),
    anOptBool: S.bool.optional(), // default value is undefined
    // this field defaults to 5; once it is set, it cannot be changed (though
    // it won't always be 5 since it can be created with a non-default value)
    immutableInt: S.int.readOnly().default(5)
  }
}

class SkierStats extends db.Model {
  static KEY = { resort: S.str }
  static FIELDS = { numSkiers: S.int.min(0).default(0) }
}

class LiftStats extends db.Model {
  static KEY = { resort: S.str }
  static FIELDS = { numLiftRides: S.int.min(0).default(0) }
}

async function liftRideTaken (resort, isNewSkier) {
  await db.Context.run({ retries: 0 }, async tx => {
    const opts = { createIfMissing: true }
    const [skierStats, liftStats] = await Promise.all([
      !isNewSkier ? Promise.resolve() : tx.get(SkierStats, resort, opts),
      tx.get(LiftStats, resort, opts)])
    if (isNewSkier) {
      skierStats.numSkiers += 1
    }
    liftStats.numLiftRides += 1
  })
}

// code from the readme (this suite is not intended to create comprehensive
// tests for features; it only verifies that code from the readme actually runs
// correctly (and continues to do so after any library changes)
class DBReadmeTest extends BaseTest {
  async testMinimalExample () {
    const id = uuidv4()
    await db.Context.run(tx => {
      const order = tx.create(OrderWithNoPrice, { id, product: 'coffee', quantity: 1 })
      expect(order.product).toBe('coffee')
      expect(order.quantity).toBe(1)
    })
    // Example
    await db.Context.run(async tx => {
      const order = await tx.get(OrderWithNoPrice, id)
      expect(order.id).toBe(id)
      expect(order.product).toBe('coffee')
      expect(order.quantity).toBe(1)
      order.quantity = 2
    })
    await db.Context.run(async tx => {
      const order = await tx.get(OrderWithNoPrice, id)
      expect(order.product).toBe('coffee')
      expect(order.quantity).toBe(2)
    })
  }

  async testKeys () {
    await db.Context.run(async tx => {
      const raceResult = await tx.get(
        RaceResult,
        { raceID: 99, runnerName: 'Bo' },
        { createIfMissing: true })
      expect(raceResult.raceID).toBe(99)
      expect(raceResult.runnerName).toBe('Bo')
    })
  }

  async testFields () {
    async function _check (how, expErr, values) {
      const id = uuidv4()
      const expBool = values.anOptBool
      const expNNInt = values.aNonNegInt
      const givenImmInt = values.immutableInt
      const expImmutableInt = (givenImmInt === undefined) ? 5 : givenImmInt

      function checkRow (row) {
        expect(row.id).toBe(id)
        expect(row.anOptBool).toBe(expBool)
        expect(row.aNonNegInt).toBe(expNNInt)
        expect(row.immutableInt).toBe(expImmutableInt)
      }

      const ret = db.Context.run(async tx => {
        const data = { id, ...values }
        let row
        if (how === 'create') {
          row = tx.create(ComplexFieldsExample, data)
        } else {
          row = await tx.get(
            ComplexFieldsExample, data, { createIfMissing: true })
          expect(row.isNew).toBe(true)
        }
        checkRow(row)
      })
      if (expErr) {
        await expect(ret).rejects.toThrow(expErr)
      } else {
        await ret
        await db.Context.run(async tx => {
          const row = await tx.get(ComplexFieldsExample, id)
          checkRow(row)
          expect(() => { row.immutableInt = 5 }).toThrow(/is immutable/)
        })
      }
    }
    async function check (values, expErr) {
      await _check('create', expErr, values)
      await _check('get', expErr, values)
    }
    // override the default value for the immutable int
    await check({ anOptBool: true, aNonNegInt: 0, immutableInt: 0 })
    // it's an error to try to set a required field to undefined (explicitly
    // passing undefined overrides the default)
    await check({ anOptBool: false, aNonNegInt: 1, immutableInt: undefined },
      /immutableInt missing required value/)
    // can omit a field with a default and it will be populated
    await check({ anOptBool: false, aNonNegInt: 2 })
    // can explicitly set an optional field to undefined
    await check({ anOptBool: undefined, aNonNegInt: 3 })
    // can also omit an optional field altogether
    await check({ aNonNegInt: 4 })
    // schemas still have to be met
    await check({ aNonNegInt: -5 },
      'Validation Error: ComplexFieldsExample.aNonNegInt')
    await check({ aNonNegInt: 6, anOptBool: 'true' },
      'Validation Error: ComplexFieldsExample.anOptBool')
    await check({ aNonNegInt: 7, immutableInt: '5' },
      'Validation Error: ComplexFieldsExample.immutableInt')

    // this is the portion from the readme; the earlier part of this test is
    // thoroughly checking correctness
    await db.Context.run(async tx => {
      // example1122start
      // can omit the optional field
      const row = tx.create(ComplexFieldsExample, {
        id: uuidv4(),
        aNonNegInt: 0,
        immutableInt: 3
      })
      expect(row.aNonNegInt).toBe(0)
      // omitted optional field => undefined
      expect(row.anOptBool).toBe(undefined)
      expect(row.immutableInt).toBe(3)

      // can override the default value
      const row2 = tx.create(ComplexFieldsExample, {
        id: uuidv4(),
        aNonNegInt: 1,
        anOptBool: true
      })
      expect(row2.aNonNegInt).toBe(1)
      expect(row2.anOptBool).toBe(true)
      expect(row2.immutableInt).toBe(5) // the default value
      // can't change read only fields:
      expect(() => { row2.immutableInt = 3 }).toThrow(
        'immutableInt is immutable so value cannot be changed')
      // example1122end
    })
  }

  async testSchemaEnforcement () {
    const id = uuidv4()
    await db.Context.run(tx => {
      // fields are checked immediately when creating a new row; this throws
      // db.InvalidFieldError because someInt should be an integer
      const data = {
        id,
        someInt: '1',
        someBool: true,
        someObj: { arr: [] }
      }
      expect(() => {
        tx.create(ModelWithFieldsExample, data)
      }).toThrow(S.ValidationError)
      data.someInt = 1
      const x = tx.create(ModelWithFieldsExample, data)

      // fields are checked when set
      expect(() => {
        x.someBool = 1 // throws because the type should be boolean not int
      }).toThrow(S.ValidationError)
      expect(() => {
        x.someObj = {} // throws because the required "arr" key is missing
      }).toThrow(S.ValidationError)
      expect(() => {
        // throws b/c arr is supposed to contain strings
        x.someObj = { arr: [5] }
      }).toThrow(S.ValidationError)
      x.someObj = { arr: ['ok'] } // ok!
    })

    const badTx = db.Context.run(async tx => {
      const row = await tx.get(ModelWithFieldsExample, id)
      expect(row.someInt).toBe(1)
      expect(row.someBool).toBe(true)
      expect(row.someObj).toEqual({ arr: ['ok'] })
      // changes within a non-primitive type aren't detected or validated until
      // we try to write the change so this next line won't throw!
      row.someObj.arr.push(5)

      expect(() => {
        row.getField('someObj').validate()
      }).toThrow(S.ValidationError)
    })
    await expect(badTx).rejects.toThrow(S.ValidationError)

    // compound key validation
    async function check (compoundID, isOk) {
      const funcs = [
        // each of these three trigger a validation check (to verify that
        // compoundID contains every key component and that each of them meet
        // their respective schemas requirements)
        () => RaceResult.key(compoundID),
        tx => tx.create(RaceResult, compoundID),
        async tx => { await tx.get(RaceResult, compoundID) }
      ]
      funcs.forEach(async func => {
        await db.Context.run(async tx => {
          if (isOk) {
            await func(tx)
          } else {
            await expect(async () => func(tx)).rejects.toThrow()
          }
        })
      })
    }
    const runnerName = uuidv4()
    await check({ raceID: '1', runnerName }, false)
    await check({ raceID: 1, runnerName }, true)
  }

  async testCustomMethods () {
    await db.Context.run(tx => {
      const id = uuidv4()
      const order = tx.create(OrderWithPrice, {
        id,
        quantity: 2,
        unitPrice: 200
      })
      expect(order.totalPrice()).toBeCloseTo(440)
    })
  }

  async testGuestbook () {
    class Guestbook extends db.Model {
      static FIELDS = { names: S.arr(S.str) }
    }
    const id = uuidv4()
    await db.Context.run(tx => {
      tx.create(Guestbook, { id, names: [] })
    })
    async function addName (name) {
      return db.Context.run(async tx => {
        const gb = await tx.get(Guestbook, id)
        gb.names.push(name)
        return gb
      })
    }
    let [gb1, gb2] = await Promise.all([addName('Alice'), addName('Bob')])
    if (gb2.names.length === 1) {
      // store first one to complete in gb1 to simplify code below
      [gb1, gb2] = [gb2, gb1]
    }
    expect(gb1.names.length + gb2.names.length).toBe(3)
    expect(gb1.names.length).toBe(1)
    expect(['Alice', 'Bob']).toContain(gb1.names[0])
    gb2.names.sort()
    expect(gb2.names).toEqual(['Alice', 'Bob'])
  }

  async testTxRetries () {
    const retryOptions = {
      retries: 4, // 1 initial run + up to 4 retry attempts = max 5 total attempts
      initialBackoff: 1, // 1 millisecond (+/- a small random offset)
      maxBackoff: 200 // no more than 200 milliseconds
    }
    let count = 0
    await expect(db.Context.run(retryOptions, async tx => {
      // you can also manually force your transaction to retry by throwing a
      // custom exception with the "retryable" property set to true
      count += 1
      const error = new Error()
      error.retryable = true
      throw error
    })).rejects.toThrow('Too much contention')
    expect(count).toBe(5)
  }

  async testPessimisticLocking () {
    // try to force the skier stats fetch to resolve first... it will fail
    // because Firestore default of pessimistic locking prevents the second
    // non-read-only transaction from acquiring locks.
    const resort = uuidv4()
    await db.Context.run(async tx => {
      const skierStats = await tx.get(SkierStats, resort)
      try {
        await liftRideTaken(resort, true)
      } catch (e) {
        expect(e.message).toContain('out of retries')
      }
      const liftStats = await tx.get(LiftStats, resort)
      expect(skierStats).toEqual(undefined)
      expect(liftStats).toEqual(undefined)
    })

    // the items were never created
    await db.Context.run(async tx => {
      const [skierStats, liftStats] = await tx.get([
        SkierStats.key(resort),
        LiftStats.key(resort)
      ])
      expect(skierStats).toEqual(undefined)
      expect(liftStats).toEqual(undefined)
    })
  }

  async testRaceCondition () {
    // by making our context NOT use a transaction, we can show how subsequent
    // reads may not be consistent with one another (one sees the state before
    // another tx, and the other the state after)
    const resort = uuidv4()
    await db.Context.run({ readOnly: true, consistentReads: false }, async tx => {
      const skierStats = await tx.get(SkierStats, resort)
      await liftRideTaken(resort, true)
      const liftStats = await tx.get(LiftStats, resort)
      expect(skierStats).toEqual(undefined)
      expect(liftStats.numLiftRides).toEqual(1)
    })

    await db.Context.run(async tx => {
      const [skierStats, liftStats] = await tx.get([
        SkierStats.key(resort),
        LiftStats.key(resort)
      ])
      expect(skierStats.numSkiers).toEqual(1)
      expect(liftStats.numLiftRides).toEqual(1)
    })
  }

  async testAddressingRows () {
    const id = uuidv4()
    expect(OrderWithNoPrice.key({ id }).keyComponents.id).toBe(id)
    expect(OrderWithNoPrice.key(id).keyComponents.id).toBe(id)

    await db.Context.run(async tx => {
      tx.create(OrderWithNoPrice, { id, product: 'coffee', quantity: 1 })
    })
    async function check (...args) {
      await db.Context.run(async tx => {
        const row = await tx.get(...args)
        expect(row.id).toBe(id)
        expect(row.product).toBe('coffee')
        expect(row.quantity).toBe(1)
      })
    }
    await check(OrderWithNoPrice.key(id))
    await check(OrderWithNoPrice, id)
    await check(OrderWithNoPrice.key({ id }))
    await check(OrderWithNoPrice, { id })
  }

  async testAddressingCompoundRows () {
    const raceID = 20140421
    const runnerName = 'Meb'
    const kc = RaceResult.key({ raceID, runnerName }).keyComponents
    expect(kc.raceID).toBe(raceID)
    expect(kc.runnerName).toBe(runnerName)
    await db.Context.run(async tx => {
      const row = await tx.get(RaceResult, { raceID, runnerName },
        { createIfMissing: true })
      expect(row.raceID).toBe(raceID)
      expect(row.runnerName).toBe(runnerName)
    })
  }

  async testCreateIfMissing () {
    const id = uuidv4()
    const dataIfOrderWithNoPriceIsNew = { id, product: 'coffee', quantity: 1 }
    async function getAndCreateIfMissing () {
      return db.Context.run(async tx => {
        const order = await tx.get(OrderWithNoPrice, dataIfOrderWithNoPriceIsNew,
          { createIfMissing: true })
        return order.isNew
      })
    }
    expect(await getAndCreateIfMissing()).toBe(true) // missing; so create it
    expect(await getAndCreateIfMissing()).toBe(false) // already exists by now
  }

  async testRead () {
    const data = { id: uuidv4(), product: 'coffee', quantity: 1 }
    await db.Context.run(tx => tx.create(OrderWithNoPrice, data))
    const row = await db.Context.run(async tx => tx.get(
      OrderWithNoPrice, data.id))
    expect(row.id).toEqual(data.id)
    expect(row.product).toEqual(data.product)
    expect(row.quantity).toEqual(data.quantity)
  }

  async testBatchRead () {
    const id = uuidv4()
    const id2 = uuidv4()
    const raceID = 123
    const runnerName = uuidv4()
    function check (order1, order2, raceResult) {
      expect(order1.id).toBe(id)
      expect(order1.product).toBe('coffee')
      expect(order1.quantity).toBe(1)
      expect(order2.id).toBe(id2)
      expect(order2.product).toBe('spoon')
      expect(order2.quantity).toBe(10)
      expect(raceResult.raceID).toBe(raceID)
      expect(raceResult.runnerName).toBe(runnerName)
    }

    await db.Context.run(async tx => {
      const [order1, order2, raceResult] = await tx.get([
        OrderWithNoPrice.data({ id, product: 'coffee', quantity: 1 }),
        OrderWithNoPrice.data({ id: id2, product: 'spoon', quantity: 10 }),
        RaceResult.data({ raceID, runnerName })
      ], { createIfMissing: true })
      check(order1, order2, raceResult)
    })

    await db.Context.run(async tx => {
      const [order1, order2, raceResult] = await tx.get([
        OrderWithNoPrice.key(id),
        OrderWithNoPrice.key(id2),
        RaceResult.key({ raceID, runnerName })
      ])
      check(order1, order2, raceResult)
    })
  }

  async testBlindWritesUpdate () {
    const id = uuidv4()
    const data = { id, product: 'coffee', quantity: 1 }
    await db.Context.run(tx => tx.create(OrderWithNoPrice, data))
    await db.Context.run(async tx => {
      const ret = await tx.updateWithoutRead(
        OrderWithNoPrice, { id, quantity: 2 })
      expect(ret).toBe(undefined) // should not return anything
    })
    await db.Context.run(async tx => {
      const order = await tx.get(OrderWithNoPrice, id)
      expect(order.id).toBe(id)
      expect(order.product).toBe('coffee')
      expect(order.quantity).toBe(2)
    })
  }

  async testBlindWritesCreateOrUpdate () {
    class LastUsedFeature extends db.Model {
      static KEY = {
        user: S.str,
        feature: S.str
      }

      static FIELDS = { epoch: S.int }
    }
    await db.Context.run(async tx => {
      // Overwrite the row regardless of the content
      const ret = tx.createOrOverwrite(LastUsedFeature,
        { user: 'Bob', feature: 'refer a friend', epoch: 234 })
      expect(ret).not.toBe(undefined) // should return a modal, like create()
    })

    await db.Context.run(tx => {
      tx.createOrOverwrite(LastUsedFeature,
        // this contains the new value(s) and the row's key; if a value is
        // undefined then the field will be deleted (it must be optional for
        // this to be allowed)
        { user: 'Bob', feature: 'refer a friend', epoch: 123 },
        // these are the current values we expect; this call fails if the data
        // exists AND it doesn't match these values
        { epoch: 234 }
      )
    })
    await db.Context.run(async tx => {
      const row = await tx.get(LastUsedFeature,
        { user: 'Bob', feature: 'refer a friend' })
      expect(row.epoch).toBe(123)
    })
  }

  async testCreateViaGetAndIncrement () {
    const id = uuidv4()
    await db.Context.run(async tx => {
      const x = await tx.get(
        OrderWithNoPrice.data({ id, product: 'coffee', quantity: 9 }),
        { createIfMissing: true })
      x.getField('quantity').incrementBy(1)
      // access value through field so we don't mess with the __Field's state
      expect(x.getField('quantity').__value).toBe(10)
    })
    await db.Context.run(async tx => {
      const order = await tx.get(OrderWithNoPrice, id)
      expect(order.quantity).toBe(10)
    })
  }

  async testPostCommitHook () {
    const mock = jest.fn()

    const fut = db.Context.run(async tx => {
      tx.addEventHandler(db.Context.EVENTS.POST_COMMIT, mock)
      throw new Error()
    })
    await expect(fut).rejects.toThrow()
    expect(mock).toHaveBeenCalledTimes(0)

    await db.Context.run(async tx => {
      tx.addEventHandler(db.Context.EVENTS.POST_COMMIT, mock)
    })
    expect(mock).toHaveBeenCalledTimes(1)

    const fut1 = db.Context.run(async tx => {
      tx.addEventHandler('123', mock)
    })
    await expect(fut1).rejects.toThrow('Unsupported event 123')
    expect(mock).toHaveBeenCalledTimes(1)
  }

  async testCreateAndIncrement () {
    const id = uuidv4()
    await db.Context.run(async tx => {
      const x = tx.create(OrderWithNoPrice, { id, product: 'coffee', quantity: 9 })
      x.getField('quantity').incrementBy(1)
      // access value through field so we don't mess with the __Field's state
      expect(x.getField('quantity').__value).toBe(10)
    })
    await db.Context.run(async tx => {
      const order = await tx.get(OrderWithNoPrice, id)
      expect(order.quantity).toBe(10)
    })
  }

  async testUpdatingRowWithoutAOL () {
    const id = uuidv4()
    await db.Context.run(async tx => {
      tx.create(OrderWithNoPrice, { id, product: 'coffee', quantity: 8 })
    })
    async function incrUpToButNotBeyondTen (origValue) {
      await db.Context.run(async tx => {
        const x = await tx.get(OrderWithNoPrice, id)
        if (x.quantity < 10) {
          x.getField('quantity').incrementBy(1)
          // trying to modify the quantity directly would generate a condition
          // on the old value (e.e.g, "set quantity to 9 if it was 8") which is
          // less scalable than "increment quantity by 1".
          // x.quantity += 1
        }
      })
      await db.Context.run(async tx => {
        const order = await tx.get(OrderWithNoPrice, id)
        expect(order.quantity).toBe(Math.min(origValue + 1, 10))
      })
    }
    await incrUpToButNotBeyondTen(8) // goes up by one
    await incrUpToButNotBeyondTen(9) // goes up again
    await incrUpToButNotBeyondTen(10) // but not any further
    await incrUpToButNotBeyondTen(10) // no matter how many times we use it
  }

  async testKeyEncoding () {
    const err = new Error('do not want to save this')
    await expect(db.Context.run(tx => {
      const row = tx.create(RaceResult, { raceID: 123, runnerName: 'Joe' })
      expect(row._id).toBe('123\0Joe')
      throw err // don't want to save this to the test db
    })).rejects.toThrow(err)

    const key = RaceResult.key({ runnerName: 'Mel', raceID: 123 })
    expect(key.Cls).toBe(RaceResult)
    expect(key.encodedKey).toBe('123\0Mel')

    class StringKeyWithNullBytesExample extends db.Model {
      static KEY = { id: S.obj().prop('raw', S.str) }
    }
    const strWithNullByte = 'I can contain \0, no pr\0blem!'
    await expect(db.Context.run(tx => {
      const row = tx.create(StringKeyWithNullBytesExample, {
        id: {
          raw: strWithNullByte
        }
      })
      expect(row.id.raw).toBe(strWithNullByte)
      throw err // don't want to save this to the test db
    })).rejects.toThrow(err)
  }

  async testIncrementBy () {
    class WebsiteHitCounter extends db.Model {
      static FIELDS = { count: S.int.min(0) }
    }

    async function slowlyIncrement (id) {
      return db.Context.run(async tx => {
        const counter = await tx.get(WebsiteHitCounter, id)
        // here we read and write the data, so the library will generate an
        // update like "if count was N then set count to N + 1"
        counter.count += 1
      })
    }

    async function quicklyIncrement (id) {
      return db.Context.run(async tx => {
        const counter = await tx.get(WebsiteHitCounter, id)
        // since we only increment the number and never read it, the library
        // will generate an update like "increment quantity by 1" which will
        // succeed no matter what the original value was
        counter.getField('count').incrementBy(1)
      })
    }

    async function bothAreJustAsFast (id) {
      return db.Context.run(async tx => {
        const counter = await tx.get(WebsiteHitCounter, id)
        if (counter.count < 100) { // stop counting after reaching 100
          // this is preferred here b/c it is simpler and just as fast in this case
          // counter.count += 1

          // isn't any faster because we have to generate the condition
          // expression due to the above if condition which read the count var
          counter.getField('count').incrementBy(1)
        }
      })
    }

    async function checkVal (id, expVal) {
      await db.Context.run(async tx => {
        const counter = await tx.get(WebsiteHitCounter, id)
        expect(counter.count).toBe(expVal)
      })
    }

    const id = uuidv4()
    await db.Context.run(tx => tx.create(
      WebsiteHitCounter, { id, count: 0 }))
    await slowlyIncrement(id)
    await checkVal(id, 1)
    await slowlyIncrement(id)
    await checkVal(id, 2)
    await quicklyIncrement(id)
    await checkVal(id, 3)
    await quicklyIncrement(id)
    await checkVal(id, 4)
    await bothAreJustAsFast(id)
    await checkVal(id, 5)
  }
}

runTests(DBReadmeTest)
