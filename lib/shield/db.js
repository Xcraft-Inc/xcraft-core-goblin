'use strict';

const {SQLite} = require('xcraft-core-book');

class ShieldUsers extends SQLite {
  constructor(location, shieldInsert, shieldUpdate, shieldDelete) {
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

      CREATE TRIGGER IF NOT EXISTS users_insert
      AFTER INSERT ON users
      BEGIN
        SELECT shield_insert(
          NEW.id,
          NEW.login,
          NEW.rank,
          NEW.createdAt,
          NEW.member
        );
      END;

      CREATE TRIGGER IF NOT EXISTS users_delete
      AFTER DELETE ON users
      BEGIN
        SELECT shield_delete(
          OLD.id,
          OLD.login,
          OLD.rank,
          OLD.createdAt,
          OLD.member
        );
      END;

      CREATE TRIGGER IF NOT EXISTS users_update
      AFTER UPDATE ON users
      BEGIN
        SELECT shield_update(
          NEW.id,
          NEW.login,
          NEW.rank,
          NEW.createdAt,
          NEW.member
        );
      END;
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
    this.open(shieldInsert, shieldUpdate, shieldDelete);
  }

  open(shieldInsert, shieldUpdate, shieldDelete) {
    const res = super.open(
      this._dbName,
      this._tables,
      this._queries,
      /* onOpen */
      () => {
        super.exec(this._dbName, 'PRAGMA journal_mode = WAL');

        if (shieldInsert) {
          this.function(
            this._dbName,
            'shield_insert',
            (id, login, rank, createAt, member) =>
              shieldInsert(id, login, rank, createAt, member)
          );
        }
        if (shieldUpdate) {
          this.function(
            this._dbName,
            'shield_update',
            (id, login, rank, createAt, member) =>
              shieldUpdate(id, login, rank, createAt, member)
          );
        }
        if (shieldDelete) {
          this.function(
            this._dbName,
            'shield_delete',
            (id, login, rank, createAt, member) =>
              shieldDelete(id, login, rank, createAt, member)
          );
        }
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
