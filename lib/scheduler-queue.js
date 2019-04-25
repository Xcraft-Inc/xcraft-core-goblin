'use strict';

const watt = require('gigawatts');
const EventEmitter = require('events');
const {locks} = require('xcraft-core-utils');

class SchedulerQueue extends EventEmitter {
  constructor() {
    super();

    this._parallelList = new Set();
    this._serieList = new Set();
    this._immediateList = new Set();
    this._mutex = new locks.Mutex();
    this._paused = true;

    this._parallel = this._parallel.bind(this);
    this._immediate = this._immediate.bind(this);
    this._error = this._error.bind(this);

    this.on('awake', () => {
      if (this._immediateList.size > 0) {
        const item = this._immediateList.values().next().value;
        this._immediateList.delete(item);
        this._runImmediate(item);
      }

      if (this._immediateList.size > 0) {
        this.emit('awake');
        return;
      }

      if (this.paused) {
        return;
      }

      if (this._parallelList.size > 0) {
        const item = this._parallelList.values().next().value;
        this._parallelList.delete(item);
        this._runParallel(item);
      } else if (this._serieList.size > 0) {
        const item = this._serieList.values().next().value;
        this._serieList.delete(item);
        this._runSerie(item);
      }

      if (this._parallelList > 0 || this._serieList.size > 0) {
        this.emit('awake');
      }
    });

    this.on('run', (type, item, next) => {
      this.emit('call', type, item, next);
      if (!this.paused) {
        this.emit('awake');
      }
    });

    this.on('parallel', this._parallel);
    this.on('serie', (...args) => this._serie(...args));
    this.on('immediate', this._immediate);

    watt.wrapAll(this, '_runSerie');
  }

  _error(err) {
    if (err) {
      this.emit('error', err);
    }
  }

  _runParallel(item) {
    this.emit('run', 'parallel', item, this._error);
  }

  *_runSerie(item, next) {
    yield this._mutex.lock();
    try {
      yield this.emit('run', 'serie', item, next);
    } catch (ex) {
      this._error(ex);
    } finally {
      this._mutex.unlock();
    }
  }

  _runImmediate(item) {
    this.emit('run', 'immediate', item, this._error);
  }

  _parallel(item) {
    this._parallelList.add(item);
    if (!this.paused) {
      this.emit('awake');
    }
  }

  _serie(item) {
    this._serieList.add(item);
    if (!this.paused) {
      this.emit('awake');
    }
  }

  _immediate(item) {
    this._immediateList.add(item);
    this.emit('awake');
  }

  get paused() {
    return this._paused;
  }

  pause() {
    this._paused = true;
  }

  resume() {
    this._paused = false;
    this.emit('awake');
  }
}

module.exports = SchedulerQueue;
