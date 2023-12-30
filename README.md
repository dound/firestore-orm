# DynamoDB Library <!-- omit in toc -->
This library is used to interact with the DynamoDB NoSQL database. It provides
high-level abstractions to structure data and prevent race conditions.

[![JSDoc](https://img.shields.io/badge/Documentation-JSDoc-green.svg?logo=githubpages)](https://pocketgems.github.io/dynamodb)

- [Core Concepts](#core-concepts)
  - [Minimal Example](#minimal-example)
  - [Tables](#tables)
    - [Keys](#keys)
    - [Fields](#fields)
    - [Schema Enforcement](#schema-enforcement)
    - [Custom Methods](#custom-methods)
  - [Transactions](#transactions)
    - [ACID Properties](#acid-properties)
    - [Retries](#retries)
    - [Read-Only](#read-only)
    - [Pre-Commit Hook](#pre-commit-hook)
    - [Warning: Race Conditions](#warning-race-conditions)
    - [Warning: Side Effects](#warning-side-effects)
    - [Per-request transaction](#per-request-transaction)
  - [Operations](#operations)
    - [Addressing Rows](#addressing-rows)
    - [Create](#create)
    - [Read](#read)
      - [Create if Missing](#create-if-missing)
      - [Read Consistency](#read-consistency)
      - [Batch Read](#batch-read)
    - [Write](#write)
    - [Delete](#delete)
  - [Performance](#performance)
    - [Blind Writes](#blind-writes)
    - [incrementBy()](#incrementby)
- [Niche Concepts](#niche-concepts)
  - [Key Encoding](#key-encoding)
  - [Nested Transactions are NOT Nested](#nested-transactions-are-not-nested)
  - [Table Creation \& Persistence](#table-creation--persistence)
  - [Indexes](#indexes)
    - [Eventual Consistency](#eventual-consistency)
    - [Creating/Editing Index(es)](#creatingediting-indexes)
    - [Cost of Indexing](#cost-of-indexing)
  - [Repeated Reads](#repeated-reads)
  - [Key Collection](#key-collection)
- [Library Collaborator's Guide](#library-collaborators-guide)
  - [AOL](#aol)
  - [Transactions](#transactions-1)
- [Appendix](#appendix)


# Core Concepts
Data is organized into tables.
A table consists of several _rows_ (also known as _items_), which
is composed of one or more _Columns_ (also known as _Fields_).
Each row is uniquely identified by a [_Key_](#keys) (more on this later).

## Minimal Example
Define a new table like this, which uses the [Todea Schema library](https://github.com/pocketgems/schema) to enfore Table schema:
```javascript <!-- embed:./test/unit-test-doc.js:scope:Order -->
class OrderWithNoPrice extends db.Model {
  static FIELDS = {
    product: S.str,
    quantity: S.int
  }
}
```

Then we can create a new row:
```javascript
const id = uuidv4()
tx.create(Order, { id, product: 'coffee', quantity: 1 })
```

Later, we can retrieve it from the database and modify it:
```javascript <!-- embed:./test/unit-test-doc.js:scope:DBReadmeTest:testMinimalExample:Example -->
    // Example
    await db.Context.run(async tx => {
      const order = await tx.get(OrderWithNoPrice, id)
      expect(order.id).toBe(id)
      expect(order.product).toBe('coffee')
      expect(order.quantity).toBe(1)
      order.quantity = 2
    })
```


## Tables

### Keys
Each row is uniquely identified by a key. By default, the key is composed of a
single field named `id` which has the format of a UUIDv4 string (e.g.,
`"c40ef065-4034-4be8-8a1d-0959695b213e"`) typically produced by calling
`uuidv4()`, as shown in the minimal example above. A row's key cannot be
changed.

You can override the default and define your key to be composed of one _or
more_ fields with arbitrary
[Todea schema](https://github.com/pocketgems/schema)s (`S`):
```javascript <!-- embed:./test/unit-test-doc.js:scope:RaceResult -->
class RaceResult extends db.Model {
  static KEY = {
    raceID: S.int,
    runnerName: S.str
  }
}
```

Access each component of a key just like any other field:
```javascript <!-- embed:./test/unit-test-doc.js:scope:DBReadmeTest:testKeys -->
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
```

It is best practice for keys to have semantic meaning whenever possible. In
this example, each runner finishes each race just one time so making the key a
combination of those values is ideal. This is better than a meaningless random
value because this:
  1. Enforces the constraint that each runner finishes each race no more than
     once. If the ID was a random value, we could accidentally create two race
     results for one runner in the same race.
  1. Enables us efficiently construct the ID from relevant information (e.g.,
     to check if a runner finished a specific race). If the ID was was a random
     value, we'd have to do some sort of search to figure out the ID associated
     with a given race ID and runner name (slow because this would involve a
     database query instead of a simple local computation!).

Note: Keys are table-specific. Two different rows in different tables may have
the same key.


### Fields
Fields are pieces of data attached to an item. They are defined similar to
`KEY` -- fields can be composed of one _or more_ fields with arbitrary
[Todea schema](https://github.com/pocketgems/schema)s (`S`) :
```javascript <!-- embed:./test/unit-test-doc.js:scope:ModelWithFields -->
class ModelWithFieldsExample extends db.Model {
  static FIELDS = {
    someInt: S.int.min(0),
    someBool: S.bool,
    someObj: S.obj().prop('arr', S.arr(S.str))
  }
}
```

* Field names are serialized and stored in the database.
  Avoid having fields with long verbose names, specially for nested ones.
* If you change the db schema, existing data isn't changed.
  That includes rows with now missing field names. [Schema Enforcement](#schema-enforcement)

Fields can be configured to be optional, immutable and/or have default values:
 * `optional()` - unless a field is marked as optional, a value must be
   provided (i.e., it cannot be omitted or set to `undefined`)
 * `readOnly()` - if a field is marked as read only, it cannot be changed once
   the row has been created
 * `default()` - the default value for a field
    * This value gets deep copied so you can safely use non-primitive type like
      an object as a default value.
    * The default value is assigned to a field when:
       * A row is created and no value is specified for the value.
       * A row is fetched and is is missing the specified field _AND_ the
         field is required.
    * The default value is _not_ assigned to an optional field that is missing
      when it is fetched from the database.
```javascript <!-- embed:./test/unit-test-doc.js:scope:ComplexFieldsExample -->
class ComplexFieldsExample extends db.Model {
  static FIELDS = {
    aNonNegInt: S.int.min(0),
    anOptBool: S.bool.optional(), // default value is undefined
    // this field defaults to 5; once it is set, it cannot be changed (though
    // it won't always be 5 since it can be created with a non-default value)
    immutableInt: S.int.readOnly().default(5)
  }
}
```
```javascript <!-- embed:./test/unit-test-doc.js:section:example1122start:example1122end -->
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
```


### Schema Enforcement
A model's schema (i.e., the structure of its data) is enforced by this library
— _NOT_ the underlying database! DynamoDB, like most NoSQL databases, is
effectively schemaless (except for the key). This means each row may
theoretically contain completely different data. This normally won't be the
case because `db.Model` enforces a consistent schema on rows in a table.

However, it's important to understand that this schema is _only_ enforced by
`db.Model` and not the underlying database. This means **changing the model
does not change any underlying data** in the database. For example, if we make
a previously optional field required, old rows which omitted the value will
still be missing the value.

The schema is checked as follows:
  1. When a field's value is changed, it is validated. If a value is a
     reference (e.g., an object or array), then changing a value inside the
     reference does _not_ trigger a validation check.
```javascript
         // fields are checked immediately when creating a new row; this throws
         // S.ValidationError because someInt should be an integer
         const data = {
           id: uuidv4(),
           someInt: '1', // does not match the schema S.int)!
           someBool: true,
           someObj: { arr: [] }
         }
         tx.create(ModelWithFields, data) // throws because someInt is invalid

         data.someInt = 1
         const x = tx.create(ModelWithFields, data)

         // fields are checked when set too
         x.someBool = 1 // throws because the type should be boolean not int
         x.someObj = {} // throws because the required "arr" key is missing
         x.someObj = { arr: [5] } // throws b/c this arr must contain strings
         x.someObj = { arr: ['ok'] } // ok!

         // changes within a non-primitive type aren't detected or validated
         // until we try to write the change so this next line won't throw!
         x.someObj.arr.push(5)
```

  2. Any fields that will be written to the database are validated prior to
     writing them. This occurs when a [transaction](#transactions) commit
     starts. This catches schema validation errors like the one on the last
     line of the previous example.

  3. Keys are validated whenever they are created or read, like these examples:
```javascript
         const compoundID = { raceID: 1, runnerName: 'Alice' }
         // each of these three trigger a validation check (to verify that
         // compoundID contains every key component and that each of them meet
         // their respective schemas requirements)
         RaceResult.key(compoundID)
         tx.create(RaceResult, compoundID)
         await tx.get(RaceResult, compoundID)
```

  4. Fields validation can be manually triggered:
```javascript
         x.getField('someObj').validate()
```

### Custom Methods
As you've noticed, key components and fields are simply accessed by their names
(e.g., `raceResult.runnerName` or `order.product`). You can also define
instance methods on your models to provide additional functionality:
```javascript <!-- embed:./test/unit-test-doc.js:scope:OrderWithPrice -->
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
```
And use them like you'd expect:
```javascript
const order = tx.create(OrderWithPrice, { id, quantity: 2 , unitPrice: 200 })
expect(order.totalPrice(0.1)).toBeCloseTo(440)
```


## Transactions
A transaction is a function which contains logic and database operations. A
transaction guarantees that all _database_ side effects (e.g., updating a
row) execute in an all-or-nothing manner, providing both
[ACID](#acid-properties) properties.


### ACID Properties
[ACID](https://en.wikipedia.org/wiki/ACID) properties are commonly provided by
traditional, transaction-processing databases:

 * _Atomicity_ - every database operation (e.g., an update) will succeed, or
   none will succeed. The database will never be partially updated.
 * _Consistency_ - data written to the database will always be consistent with
   the constraints specified by the models (e.g., it is not possible to store a
   string in an integer field).
 * _Isolation_ - each transaction will appear to operate sequentially;
   uncommitted data cannot be read.
 * _Durability_ - if a transaction succeeds, any data that is changed will be
   remembered. There is no chance of it being lost (e.g., due to a power
   outage).


### Retries
When a transaction fails due to contention, it will retry after a short, random
delay. Randomness helps prevent conflicting transactions from conflicting again
when they retry. Context retry behaviors can be customized:
```javascript
const retryOptions = {
  retries: 4, // 1 initial run + up to 4 retry attempts = max 5 total attempts
  initialBackoff: 100, // 100 milliseconds (+/- a small random offset)
  maxBackoff: 500 // no more than 500 milliseconds
}
await db.Context.run(retryOptions, async tx => {
  // you can also manually force your transaction to retry by throwing a
  // custom exception with the "retryable" property set to true
  const error = new Error()
  error.retryable = true
  throw error
})
// Exponential backoff function doubles the backoff each time (up to the max)
// t=0ms, initial run
// t=100ms, retry 1 (backed off for 100ms)
// t=300ms, retry 2 (backed off again, this time for 200ms)
// t=700ms, retry 3 (backed off again, this time for 400ms)
// t=1200ms, retry 4 (backed off for 500ms this time; was capped by maxBackoff)
// fail
```

### Read-Only
You can ensure a transaction does not make any database changes by setting the
`readOnly` option to true, or calling `tx.makeReadOnly()`:
```javascript
const readOnlyOption = { readOnly: true }
await db.Context.run(readOnlyOption, async tx => { /* ... */ })
await db.Context.run(async tx => {
  tx.makeReadOnly()
  // ...
})
```

### Pre-Commit Hook
A model might need to automate logic before it is committed to store. For example, a `Ledger` model may want to update a `ver` field any time it is updated. Such logic can be achieved through the `Model.finalize` hook.

```javascript <!-- embed:./test/unit-test-transaction.js:scope:HookExample -->
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
```


### Warning: Race Conditions
Race conditions are still possible! Consider a ski resort which records some
stats about skiers and lifts:
```javascript
class SkierStats extends db.Model {
  static KEY = { resort: S.str }
  static FIELDS = { numSkiers: S.int.min(0).default(0) }
}
class LiftStats extends db.Model {
  static KEY = { resort: S.str }
  static FIELDS = { numLiftRides: S.int.min(0).default(0) }
}
```

We can correctly update these numbers in a transaction like this:
```javascript
async function liftRideTaken(resort, isNewSkier) {
  await db.Context.run(async tx => {
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
```

However, if we try to read them we can't guarantee a consistent snapshot:
```javascript
const skierStats = await tx.get(SkierStats, resort)
const liftStats = await tx.get(LiftStats, resort)
```

This sequence is possible:
  1. We issue requests to read SkierStats and LiftStats, as above.
  1. We call `liftRideTaken('someResort', true)`
  1. The request to read skier stats complete: `numSkiers=0`
  1. The `liftRideTaken('someResort', true)` completes, transactionally
     updating the database to `numSkiers=1` and `numLiftRides=1`.
  1. The request to read lift stats complete: `numLiftRides=1` _!!!_
  1. Our application code thinks there was one lift ride taken, but no skiers.

To ensure this does not occur, use `db.get()` to fetch both rows in a single
request:
```javascript
const [skierStats, liftStats] = await tx.get([
  SkierStats.key(resort),
  LiftStats.key(resort)
])
```

Under the hood, when multiple rows are fetched with strong consistency,
DynamoDB's `transactGetItems` API is called to prevent races mentioned above.


### Warning: Side Effects
Keep in mind that transactions only guarantee all-or-nothing (or more
precisely, exactly once or not at all semantics) for _database_ operations. If
the application code which defines the transaction has side effects, those side
effects may occur even if the transaction doesn't commit. They could even occur
multiple times (if your transaction retries).
```javascript
  await db.Context.run(async tx => {
    const row = await tx.get(...)
    row.someInt += 1
    if (row.someInt > 10) {
      // making an HTTP request is a side effect!
      await got('https://example.com/theRowHassomeIntBiggerThan10')
    }
  })
```

In this example, the HTTP request might be completed one or more times, even if
the transaction never completes successfully!


### Per-request transaction
Each request handled by our
[API Definition library](https://pocketgems.github.io/app/libs/api/index.html)
is wrapped in a transaction.


## Operations
_All_ databases operations occur in the scope of a transaction. We typically
name the transaction object `tx` in code. This section discusses the operations
supported by `tx`.


### Addressing Rows
Database operations always occur on a particular row. The canonical way to identify a particular row is:
```javascript
MyModel.key({ /* a map of key component names to their values */ })
Order.key({ id: uuidv4() })
RaceResult.key({ raceID: 1, runnerName: 'Dave' })
```

For models which have only a single key field, you _may_ omit the field name:
```javascript
Order.key(uuid4())
```

The `db.Key` object produced by this `key()` method is used as the first
argument to database operations:
```javascript
tx.get(Order.key(id))
```

For convenience, you may also split the model class and key values up into two
arguments:
```javascript
tx.get(Order, id)
tx.get(RaceResult, { raceID, runnerName })
```


### Create
`tx.create()` instantiates a new row in local memory. This method is a local,
**synchronous** method (no network traffic is generated). If a row with the
same key already exists, a `db.ModelAlreadyExistsError` is thrown when the
transaction attempts to commit (without retries, as we don't expect rows to be
deleted).

To create a row, you need to supply the model (the type of data you're
creating) and a map of its initial values:
```javascript
tx.create(Order, { id, product: 'coffee', quantity: 1 })
```


### Read
`tx.get()` **asynchronously** retrieves data from the database. Network traffic
is generated to ask the database for the data as soon as the method is call,
but other work can be done while waiting.
```javascript
const orderPromise = tx.get(Order, id)
// do some other work
const order = await orderPromise // block until the data has been retrieved
```

`tx.get()` accepts an additional options to configure its behavior:
  * `createIfMissing` - see [Create if Missing](#create-if-missing)


#### Create if Missing
If the row does not exist in the database, then by default the returned value
will be `undefined`. You may ask for it to instead be created if it does not
exist. To do this, you need to supply not only the row's key, but also the
data you want it to have _if_ it does not yet exist:
```javascript
const dataIfOrderIsNew = { id, product: 'coffee', quantity: 1 }
const order = await tx.get(Order, dataIfOrderIsNew, { createIfMissing: true })
if (order.isNew) { // you can check if the row already existed or not
  // ...
}
```

The `isNew` property is set when the model is instantiated (after receiving the
database's response to our data request). When the transaction commits, it will
ensure that the row is still being created if `isNew=true` (i.e., the row
wasn't created by someone else in the meantime) or still exists if
`isNew=false` (i.e., the row hasn't been deleted in the meantime).


#### Read Consistency
Consistent reads (the default and only option) provide strong
consistency. In theory, Firestore supports eventually consistent reads but
these are not exposed in their NodeJS client library so we don't support them.

#### Batch Read
It is also possible to call `tx.get()` with an array of keys in order to fetch
many things at once:
```javascript
const [order1, order2, raceResult] = await tx.get([
  Order.key(id),
  Order.key(anotherID),
  RaceResult.key({ raceID, runnerName })
])
```

This can also be combined with `createIfMissing`:
```javascript
const [order1, order2, raceResult] = await tx.get([
  Order.data({ id, product: 'coffee', quantity: 1 }),
  Order.data({ id: anotherID, product: 'spoon', quantity: 10 }),
  RaceResult.data({ raceID, runnerName })
], { createIfMissing: true })
```

* Data is fetched transactionally and will be a consistent snapshot
  (see [race conditions](#warning-race-conditions) for more about this).

### Write
To modify data in the database, simply modify fields on a row created by
`tx.create()` or fetched by `tx.get()`. When the transaction commits, all
changes will be written to the database automatically.

For improved performance, data can be updated without being read from database
first. See details in [blind writes](#blind-writes).

### Delete
Rows can be deleted from the database via `tx.delete()`. The delete method
accepts models or keys as parameters. For example,
`tx.delete(model1, key1, model2, ...keys, key2)`.

For models that were read from server via `tx.get()`, if the model turns out to
be missing on server when the transaction commits, an exception is thrown.
Otherwise, deletion on missing rows will be treated as noop.

## Performance
### Blind Writes
Blind updates write a row to the DB without reading it first. This is useful
when we wish to update them without the overhead of an unnecessary read (in
theory, the update can have preconditions but this isn't supported yet... just
do a read in that case to verify them):
```javascript
// this updates the specified order row to quantity=2
tx.updateWithoutRead(Order, { id, quantity: 2 })
```

To maintain consistency, old values _must_ be provided for each field to be
updated. In addition, any values used to derive the new value should be
included in the old values. Failure to do so may result in race condition bugs.

Similarly, rows can be blindly created or overwritten with `createOrOverwrite`
method. This is useful when we don't care about the previous value (if any).
For example, maybe we're tracking whether a customer has used a particular
feature or not. When they use it, we may just want to blindly record it:
```javascript <!-- embed:./test/unit-test-doc.js:scope:testBlindWritesCreateOrUpdate -->
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
      expect(ret).toBe(undefined) // should not return anything
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
```

Both of these methods are synchronous, local methods like `tx.create()`. They
return immediately and do not perform any network traffic. All network traffic
related to these are generated as part of any writes processed when the
transaction commits.


### incrementBy()
To achieve higher write throughput and reduce contention, you can use
`incrementBy()` to mutate numeric fields. This can be used when you want to
increment (or decrement) a number's value but don't care about its old value:
```javascript
class WebsiteHitCounter extends db.Model {
  static FIELDS = { count: S.int.min(0) }
}

async function slowlyIncrement(id) {
  const counter = await tx.get(WebsiteHitCounter, id)
  // here we read and write the data, so the library will generate an
  // update like "if count was N then set count to N + 1"
  counter.count += 1
}

async function quicklyIncrement(id) {
  const counter = await tx.get(WebsiteHitCounter, id)
  // since we only increment the number and never read it, the library will
  // generate an update like "increment quantity by 1" which will succeed no
  // matter what the original value was
  counter.getField('count').incrementBy(1)
}
```

Using the `incrementBy()` only helps if you're not going to read the field
being incremented (though it never hurts to use it):
```javascript
async function bothAreJustAsFast(id) {
  const counter = await tx.get(WebsiteHitCounter, id)
  if (counter.count < 100) { // stop counting after reaching 100
    // this is preferred here b/c it is simpler and just as fast in this case
    // counter.count += 1

    // isn't any faster because we have to generate the condition
    // expression due to the above if condition which read the count var
    counter.getField('count').incrementBy(1)
  }
}
```

Using `incrementBy()` on a field whose value is `undefined` is invalid and will
throw an exception.


# Niche Concepts

## Key Encoding
Under the hood, a database key can only be a single attribute. We always store
that attribute as a string. We compute this string's value by first sorting the
names of the components of the key. Then we compute the string representation
of each component's value (with `JSON.stringify()`, except for string values
which don't need to be encoded like that). Finally, we concatenate these values
(in order of their keys) and separate them with null characters. An encoded key
would look like this:
```javascript
const row = tx.create(RaceResult, { raceID: 123, runnerName: 'Joe' })
expect(row._id).toBe('123\0Joe')

// the encoded key is also contained in the output of Model.key():
const key = RaceResult.key({ runnerName: 'Mel', raceID: 123 })
expect(key.Cls).toBe(RaceResult)
expect(key.encodedKey).toBe('123\0Mel')
```

For this reason, string values cannot contain the null character. If you need
to store a string with this value, your best option is to probably nest it
inside of an object:
```javascript
class StringKeyWithNullBytes extends db.Model {
  static KEY = { id: S.obj().prop('raw', S.str) }
}
tx.create(StringKeyWithNullBytes, {
  id: {
    raw: 'I can contain \0, no pr\0bl\0em!'
  }
})
```

## Nested Transactions are NOT Nested
Nested transactions like this should be avoided:
```javascript
await Context.run(async outerTx => {
  // ...
  await Context.run(async innerTx => {
    // ...
  }
}
```
The inner transaction, if it commits, will commit first. If the outer
transaction is retried, the inner transaction _will be run additional times_.


## Table Creation & Persistence
When the localhost server runs, it generates `config/resources.yml` based on
the models you've defined (make sure to export them from your service!). On
localhost, the data persists until you shut down the service. If you add new
models or change a model (particularly its key structure), you will need to
restart your service to incorporate the changes.

Along the same lines, keep in mind that the localhost database is _not_ cleared
in between test runs. Any data added to the localhost database will remain
until the service is restarted. This can help you debug issues, but it also
means you should not create rows with a fixed ID as part of a unit test (use
`uuidv4()` to get a random ID value so it won't clash with a future run of the
unit tests.)

Whenever a service is deployed to test or prod, any table which did not
previously exist is created. _If a table is removed, its data will still be
retained._ It must be manually deleted if its data is no longer needed. This
is a safety precaution to avoid data loss.

Be careful about changing your models: remember that changing the model does
_not_ change anything in the database. Be especially wary about changing the
key structure — it will probably cause serious problems.


## Indexes

Indexes are required by Firestore in order to perform queries. Indexes are automatically kept up to date but are only eventually consistent.


### Eventual Consistency

Indexes are eventually consistent. This means that when a database row is updated, its index(es) are updated sometime later. Usually this happens quickly (within seconds) but it could be longer (potentially much longer). Therefore you need to be careful when querying an index and account for this.

```javascript <!-- embed:./test/unit-test-model.js:section:GuildMetadataStart:GuildMetadataEnd -->
    const GuildMetadata = class extends db.Model {
      static KEY = { name: S.str }
      static FIELDS = { league: S.str, rank: S.int }
    }
```
If you query by league, you may find some inconsistency between the league of a guild queried directly vs the list of all the guilds in a league queried using the index.


### Creating/Editing Index(es)

`Backfilling`: When you create a new index, it is not backfilled automatically. Index is guaranteed to update ONLY when a model row is saved. TODO: double-check when backfilling occurs for Firestore.

TIP: You can use Dataflow to read/re-write of all the rows.


### Cost of Indexing

Indexes increase the physical storage and data write cost for the model.


## Repeated Reads
By default, reading a row twice in a single transaction is treated as an
exception.
```javascript
await db.Context.run(async tx => {
  await tx.get(SomeModel, "model id")
  // await tx.get(SomeModel, "model id") // throws exception
})
```

In some occasions, we may need to allow the same row to be read more than
once. For example, a transaction may be handling a batch of operations (action
pattern with batching), where individual operation might read and update the
same row.
```javascript
const operation = async (tx) => {
  const model = await tx.get(SomeModel, "some id")
  model.intField += 1
}

const operations = [operation, operation]

await db.Context.run(async tx => {
  for (const op of operations) {
    // Second iteration will throw
    await op(tx)
  }
})
```

To allow reading the same row more than once, a `cacheModels` option can be
toggled on. In this mode, when a row is first read, it is cached by the
transaction, and the transaction will return the cached model for any
subsequent reads.
```javascript
await db.Context.run({ cacheModels: true },async tx => {
  // This transaction will complete ok
  for (const op of operations) {
    await op(tx)
  }
})
```

Any modifications made to the cached row will be stored along with the row,
so subsequent reads will see the previous updates.
 ```javascript
await db.Context.run({ cacheModels: true },async tx => {
  const model = await tx.get(SomeModel, "some id")
  model.intField = 123

  const cachedModel = await tx.get(SomeModel, "some id")
  expect(cachedModel.intField).toBe(123)
})
```

Repeated reads can be enabled during a transaction because transactions track
all referenced rows. Call `enableModelCache` to turn it on.
```javascript
await db.Context.run(async tx => {
  ...
  tx.enableModelCache()
  ...
})
```

If [an operation other than read](#operations) was done on the row (e.g.
delete, or create, etc.), a subsequent attempt to read the row will result in
an exception regardless of the cacheModels flag value.

## Key Collection
When duplicated keys are passed to `tx.get()`, an error will result, even if
[model cache](#repeated-reads) is enabled, because it is more likely to be a
coding error in common use cases. Keys must be de-duplicated by removing
repeated class and key combinations. The `db.UniqueKeyList` class
provides an `Array` like interface to simplify the deduplication process.
```javascript
const keys = new db.UniqueKeyList(MyModel.key('123'))
keys.push(MyModel.key('123'), ...[MyModel.key('123')])
const rows = await tx.get(keys)
```

# Library Collaborator's Guide

## AOL
This library automates optimistic locking by tracking fields accessed and
constructing expressions under the hood, thus entirely avoid hand crafting
requests like above. Rules are as following:

* For **ConditionExpression**
    - If a model does not exists on server:
        - Set expression to `'attribute_not_exists(id)'`
    - Else
        - For each field read or written:
            - Append `field=oldValue`

* For **UpdateExpression**
    - For each field written:
        - If `newValue === undefined`:
            - Append `'field'` to _REMOVE_ section
        - If `newValue !== undefined`:
            - Append `'field=newValue'` to _SET_ section


## Transactions
Our `Context` class, combines AOL and DynamoDB's transactWrite with the
following strategy:

* Individual get operations are allowed within a transaction context.
* Models read are tracked by the transaction context.
* Models mutated are written to DB using one single transactWrite operation on
  commit.
* TransactWrite request is constructed using the following rules:
    * For each readonly rows:
        * Append ConditionExpressions generated using AOL
    * For each read-write rows:
        * Append UpdateExpression generated using AOL.
        * Append ConditionExpressions generated using AOL
* Context commits when the transaction context / scope is exited.
* If a `retryable` error or `ConditionalCheckFailedException` or
  `TransactionCanceledException` is thrown during transactWrite operation,
  transaction will be retried.
* If all retries failed, a `TransactionFailedError` will be thrown.

When more than one row is accessed and/or updated, this library issues a
`transactWriteItems` call to DynamoDB. For performance reasons, if exactly one
row was accessed and updated, this library uses a non-transactional
`writeItem` call to provide the same ACID properties a transactWrite could
provide.


# Appendix
The samples in this readme can be found in the APIs defined for unit testing
this library in `test/unit-test-doc.js` in the
`DBReadmeTest` class.
