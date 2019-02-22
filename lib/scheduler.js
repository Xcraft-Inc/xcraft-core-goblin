'use strict';

const EventEmitter = require('events');
const watt = require('gigawatts');
const uuidV4 = require('uuid/v4');
const $ = require('highland');

class Scheduler {
  constructor(goblinName, isSingleton, generation, questDispatch) {
    this._goblinName = goblinName;

    this._generationId = generation || uuidV4();

    this.questEmitter = new EventEmitter();
    this._questDispatch = questDispatch;
    this._queue = new EventEmitter();

    const serieRunner = $('serie', this._queue)
      .map(({goblin, questName, quest, dispatch, done}) => next => {
        this._questDispatch(goblin, questName, quest, dispatch, done, next);
      })
      .nfcall([])
      .sequence()
      .stopOnError(err => console.warn(err));

    const parallelRunner = $('parallel', this._queue)
      .map(({goblin, questName, quest, dispatch, done}) => next => {
        this._questDispatch(goblin, questName, quest, dispatch, done, next);
      })
      .nfcall([])
      .parallel(Number.MAX_VALUE)
      .stopOnError(err => console.warn(err));

    //Singleton? enable runners
    if (isSingleton) {
      parallelRunner.done();
      serieRunner.done();
    }

    $('create', this._queue)
      .map(({goblin, questName, quest, dispatch, done}) => next => {
        const _done = () => {
          if (questName === 'create') {
            if (parallelRunner.paused) {
              parallelRunner.done();
            }
            if (serieRunner.paused) {
              serieRunner.done();
            }
          }
          done();
        };
        this._questDispatch(goblin, questName, quest, dispatch, _done, next);
      })
      .nfcall([])
      .parallel(Number.MAX_VALUE)
      .stopOnError(err => console.warn(err))
      .done();

    $('dispatch-quest', this.questEmitter)
      .map(payload => next => this._dispatcher(payload, next))
      .nfcall([])
      .sequence()
      .stopOnError(err => console.warn(err))
      .done();

    this.apiPromises = [];
    this.createPromises = [];

    this.deletePromise = null;

    watt.wrapAll(this, '_dispatcher');
  }

  nextDelete(call) {
    this.deletePromise = new Promise(resolve => call(resolve));
    this.deletePromise.then(() => {
      this.deletePromise = null;
    });
  }

  nextParallel(call, promises) {
    const promise = new Promise(resolve => call(resolve));
    promises.push(promise);
    const index = promises.length - 1;
    promise.then(() => {
      promises.splice(index, 1);
    });
  }

  *_dispatcher({goblin, questName, quest, dispatch, cmdMode, msg, resp}, next) {
    switch (cmdMode) {
      case 'delete':
        if (msg.data.generation !== goblin._generationId) {
          resp.events.send(`${this._goblinName}.delete.${msg.id}.finished`);
          return;
        }

        yield Promise.all(this.createPromises);
        this.createPromises = [];
        yield Promise.all(this.apiPromises);
        this.apiPromises = [];

        this.nextDelete(done =>
          this._questDispatch(
            goblin,
            questName,
            quest,
            dispatch,
            done,
            next.parallel()
          )
        );
        yield next.sync();
        break;

      case 'recreate':
        if (this.deletePromise) {
          yield this.deletePromise;
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
           *        Maybe it's just because the deletePromise was just
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
          this.nextParallel(
            done =>
              this._queue.emit('create', {
                goblin,
                questName,
                quest,
                dispatch,
                done,
              }),
            this.createPromises
          );
        } else {
          this.nextParallel(
            done =>
              this._queue.emit('create', {
                goblin,
                questName,
                quest,
                dispatch,
                done,
              }),
            this.apiPromises
          );
        }
        break;

      case 'serie':
        this.nextParallel(
          done =>
            this._queue.emit('serie', {
              goblin,
              questName,
              quest,
              dispatch,
              done,
            }),
          this.apiPromises
        );
        break;

      case 'parallel':
        this.nextParallel(
          done =>
            this._queue.emit('parallel', {
              goblin,
              questName,
              quest,
              dispatch,
              done,
            }),
          this.apiPromises
        );
        break;
    }
  }
}

module.exports = Scheduler;
