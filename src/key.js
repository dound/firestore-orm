/**
 * Key uniquely identifies a model.
 */
class Key {
  /**
   * @param {Model} Cls a Model class
   * @param {Object} encodedKey encoded key
   * @param {Object} keyComponents key component values
   * @private
   */
  constructor (Cls, encodedKey, keyComponents) {
    this.Cls = Cls
    this.encodedKey = encodedKey
    this.keyComponents = keyComponents
  }

  get docRef () {
    const db = Key.firestoreDB
    return db.collection(this.Cls.tableName).doc(this.encodedKey)
  }
}

/**
 * An array which ensures it has no more than one copy of any key.
 *
 * This is useful because key equality cannot be checked with the
 * built-in equality operator.
 */
class UniqueKeyList extends Array {
  constructor (...keys) {
    super(...keys)
    const hashes = keys.map(key => this.constructor.getKeyHash(key))
    this.__keyHashes = new Set(hashes)
  }

  static getKeyHash (key) {
    return `${key.Cls.name}::${key.encodedKey}`
  }

  push (...keys) {
    for (const key of keys) {
      const keyHash = this.constructor.getKeyHash(key)
      if (!this.__keyHashes.has(keyHash)) {
        this.__keyHashes.add(keyHash)
        super.push(key)
      }
    }
  }

  filter (...args) {
    return Array.prototype.filter.bind(this, ...args)
  }

  map (f) {
    const ret = []
    for (let i = 0; i < this.length; i++) {
      ret.push(f(this[i]))
    }
    return ret
  }
}

module.exports = {
  Key,
  UniqueKeyList
}
