'use strict';

const EventEmitter = require('events');
const watt = require('gigawatts');
const uuidV4 = require('uuid/v4');
const $ = require('highland');

class Scheduler {
  dispose() {
    this._dispatchQuestRunner.destroy();
    this._createRunner.destroy();
    this._parallelRunner.destroy();
    this._serieRunner.destroy();
  }
  constructor(goblinName, isSingleton, generation, questDispatch) {
    this._goblinName = goblinName;

    this._generationId = generation || uuidV4();

    this.questEmitter = new EventEmitter();
    this._questDispatch = questDispatch;
    this._queue = new EventEmitter();

    this._serieRunner = $('serie', this._queue)
      .map(({goblin, questName, quest, dispatch, done, promiseId}) => next => {
        this._questDispatch(
          goblin,
          questName,
          quest,
          dispatch,
          done,
          promiseId,
          next
        );
      })
      .nfcall([])
      .sequence()
      .stopOnError(err => console.warn(err));

    this._parallelRunner = $('parallel', this._queue)
      .map(({goblin, questName, quest, dispatch, done, promiseId}) => next => {
        this._questDispatch(
          goblin,
          questName,
          quest,
          dispatch,
          done,
          promiseId,
          next
        );
      })
      .nfcall([])
      .parallel(Number.MAX_VALUE)
      .stopOnError(err => console.warn(err));

    //Singleton? enable runners
    if (isSingleton) {
      this._parallelRunner.done();
      this._serieRunner.done();
    }

    this._createRunner = $('create', this._queue)
      .map(({goblin, questName, quest, dispatch, done, promiseId}) => next => {
        const _done = (...args) => {
          if (questName === 'create') {
            if (this._parallelRunner.paused) {
              this._parallelRunner.done();
            }
            if (this._serieRunner.paused) {
              this._serieRunner.done();
            }
          }
          done(...args);
        };
        this._questDispatch(
          goblin,
          questName,
          quest,
          dispatch,
          _done,
          promiseId,
          next
        );
      })
      .nfcall([])
      .parallel(Number.MAX_VALUE)
      .stopOnError(err => console.warn(err));

    this._createRunner.done();

    this._dispatchQuestRunner = $('dispatch-quest', this.questEmitter)
      .map(payload => next => this._dispatcher(payload, next))
      .nfcall([])
      .sequence()
      .stopOnError(err => console.warn(err));

    this._dispatchQuestRunner.done();

    this._promises = {};
    this._deletePromise = null;

    watt.wrapAll(this, '_dispatcher');
  }

  nextDelete(call) {
    this._deletePromise = new Promise(resolve => call(resolve));
    this._deletePromise.then(() => {
      this._deletePromise = null;
    });
  }

  nextParallel(call) {
    const id = Symbol();
    const promise = new Promise(resolve => call(resolve, id));
    this._promises[id] = promise;
    promise.then(id => {
      delete this._promises[id];
    });
  }

  *_dispatcher({goblin, questName, quest, dispatch, cmdMode, msg, resp}, next) {
    switch (cmdMode) {
      case 'delete':
        if (msg.data.generation !== goblin._generationId) {
          resp.events.send(`${this._goblinName}.delete.${msg.id}.finished`);
          return;
        }

        if (Object.keys(this._promises).length) {
          for (const promise in this._promises) {
            promise.then(next.parallel().args(0));
          }
          yield next.sync();
        }

        this.nextDelete(done =>
          this._questDispatch(
            goblin,
            questName,
            quest,
            dispatch,
            done,
            null,
            next.parallel()
          )
        );
        yield next.sync();
        break;

      case 'recreate':
        if (this._deletePromise) {
          yield this._deletePromise;
          /* and fallthrough the create case */
        } else {
          const toUpsert = goblin.getState().state.delete('private');

          /* First create already creating, go out (break) */
          if (toUpsert.size === 0 && goblin._runningQuests.create >= 2) {
            resp.events.send(
              `${this._goblinName}.create.${msg.id}.finished`,
              goblin.id
            );
            break;
          }

          /* Upsert again and go out (break) */
          if (toUpsert.size > 0) {
            const payload = {
              branch: goblin.id,
              data: toUpsert,
              parents: msg.data.parent,
              feeds:
                (msg.data &&
                  msg.data._goblinFeed &&
                  Object.keys(msg.data._goblinFeed)) ||
                null,
            };
            yield resp.command.send(`warehouse.upsert`, payload, next);

            resp.events.send(
              `${this._goblinName}.create.${msg.id}.finished`,
              goblin.id
            );
            break;
          }

          /* FIXME: it should never happend? Then create fully again.
           *        Maybe it's just because the _deletePromise was just
           *        resolved after the recreate detection?! Why not..
           *        If it's the reason, then it's right to fallthrough.
           */
          if (toUpsert.size === 0) {
            console.warn(
              `Empty state when recreating ${goblin.id}, 'create' fallthrough`
            );
          }

          /* fallthrough ... break is not missing here*/
        }

      /* eslint no-fallthrough: "error" */
      case 'create':
        /* create commands and commands called from create */
        if (questName === 'create') {
          this.nextParallel((done, promiseId) =>
            this._queue.emit('create', {
              goblin,
              questName,
              quest,
              dispatch,
              done,
              promiseId,
            })
          );
        } else {
          this.nextParallel((done, promiseId) =>
            this._queue.emit('create', {
              goblin,
              questName,
              quest,
              dispatch,
              done,
              promiseId,
            })
          );
        }
        break;

      case 'serie':
        this.nextParallel((done, promiseId) =>
          this._queue.emit('serie', {
            goblin,
            questName,
            quest,
            dispatch,
            done,
            promiseId,
          })
        );
        break;

      case 'parallel':
        this.nextParallel((done, promiseId) =>
          this._queue.emit('parallel', {
            goblin,
            questName,
            quest,
            dispatch,
            done,
            promiseId,
          })
        );
        break;
    }
  }
}

module.exports = Scheduler;
