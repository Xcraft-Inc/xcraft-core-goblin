const {SQLite} = require('xcraft-core-book');
const {pipeline} = require('node:stream/promises');
const {MessagePortWritable} = require('xcraft-core-cryo/lib/streamPort.js');
const {ReadableSQL} = require('xcraft-core-cryo/lib/streamSQL.js');

async function exec({port, location, query}) {
  let readStream;
  const writeStream = new MessagePortWritable(port);
  const sqlite = new SQLite(location);

  try {
    const {sql, values, tables} = query;

    const queries = {
      query: sql,
    };

    const db = tables.find(({db}) => !db).dbId;

    const attach = () => {
      for (const {dbId: id, db: alias} of tables) {
        const attachPath = `file:${sqlite._path(id)}?mode=ro`;
        const stmt = sqlite.prepare(db, `ATTACH $attachPath as $alias;`);
        stmt.run({attachPath, alias});
      }
    };

    sqlite.open(db, null, queries, attach, null, null, {readonly: true});
    sqlite._db[db].unsafeMode(true);

    readStream = new ReadableSQL(sqlite.stmts(db).query, values, SQLite.wait);
    await pipeline(readStream, writeStream);
  } catch (ex) {
    port.postMessage(ex);
  } finally {
    if (readStream) {
      readStream.abort();
    }
    sqlite.dispose();
  }
}

module.exports = {
  exec,
};
