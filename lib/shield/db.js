'use strict';

const {SQLite} = require('xcraft-core-book');

class ShieldUsers extends SQLite {
  constructor(location) {
    super(location);

    this._location = location;

    this._tables = `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        login TEXT,
        rank TEXT,
        createdAt INTEGER,
        lastAccess INTEGER,
        member TEXT
      );
    `;

    this._queries = {};

    this._queries.save = `
      INSERT OR REPLACE INTO users
      VALUES ($id, $login, $rank, $createdAt, $lastAccess, $member)
    `;

    this._queries.delete = `
      DELETE FROM users
      WHERE id = $id
    `;

    this._queries.read = `
      SELECT *
      FROM users
      WHERE id = $id
    `;

    this._queries.deleteAll = `
      DELETE FROM users
    `;

    this._dbName = 'users';
    this.open();
  }

  open() {
    const res = super.open(
      this._dbName,
      this._tables,
      this._queries,
      /* onOpen */
      () => {
        super.exec(this._dbName, 'PRAGMA journal_mode = WAL');
      }
    );
    if (!res) {
      throw new Error('something wrong happens with SQLite');
    }
    return res;
  }

  get(id) {
    this.open();
    const data = this.stmts(this._dbName).read.get({id});
    if (!data) {
      return null;
    }
    data.member = data.member === 'true' ? true : false;
    return data;
  }

  save(id, data) {
    this.open();
    this.stmts(this._dbName).save.run({
      id,
      login: data.login,
      rank: data.rank,
      createdAt: data.createdAt,
      lastAccess: data.lastAccess,
      member: data.member ? 'true' : 'false',
    });
  }

  delete(id) {
    this.open();
    this.stmts(this._dbName).delete.run({id});
  }

  deleteAll() {
    this.open();
    this.stmts(this._dbName).deleteAll.run();
  }
}

module.exports = ShieldUsers;
