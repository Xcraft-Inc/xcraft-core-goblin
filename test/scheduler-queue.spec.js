'use strict';

const watt = require('gigawatts');
const {expect} = require('chai');
const SchedulerQueue = require('../lib/scheduler-queue.js');

describe('xcraft.goblin.scheduler-queue', function () {
  it(
    'serie',
    watt(function* (next) {
      let acc = 0;
      let cnt = 0;
      const queue = new SchedulerQueue();

      const _next = next.parallel();

      queue.on('call', (type, item, next) => {
        if (type === 'serie') {
          ++cnt;
          acc += item;
          setTimeout(() => {
            if (cnt === 1) {
              expect(acc).to.be.equal(3);
            } else if (cnt === 2) {
              expect(acc).to.be.equal(5);
            } else if (cnt === 3) {
              expect(acc).to.be.equal(6);
              _next();
            }
            next();
          }, 10 * item);
        }
      });

      queue.resume();

      let time = process.hrtime();

      queue.emit('serie', 3); // 30ms
      queue.emit('serie', 2); // 20ms
      queue.emit('serie', 1); // 10ms

      yield next.sync();

      time = process.hrtime(time);
      expect(time[1]).greaterThan(60e6);
      expect(acc).to.be.equal(6);
    })
  );

  it('parallel', async function () {
    let acc = 0;
    let cnt = 0;
    const queue = new SchedulerQueue();

    queue.resume();

    let time;

    await new Promise((resolve) => {
      queue.on('call', (type, item) => {
        if (type === 'parallel') {
          setTimeout(() => {
            ++cnt;
            acc += item;
            if (cnt === 1) {
              expect(acc).to.be.equal(1);
            } else if (cnt === 2) {
              expect(acc).to.be.equal(3);
            } else if (cnt === 3) {
              expect(acc).to.be.equal(6);
              resolve();
            }
          }, 10 * item);
        }
      });

      time = process.hrtime();

      queue.emit('parallel', 3); // 30ms
      queue.emit('parallel', 2); // 20ms
      queue.emit('parallel', 1); // 10ms
    });

    time = process.hrtime(time);
    expect(time[1]).greaterThan(28e6).and.lessThan(58e6);
    expect(acc).to.be.equal(6);
  });

  it('immediate', function (done) {
    let acc = 0;
    const queue = new SchedulerQueue();

    // The first message must be 'immediate'
    queue.once('call', (type, item) => {
      expect(type).to.be.equal('immediate');
      expect(item).to.be.equal(1);
    });

    queue.on('call', (type, item) => {
      if (type === 'immediate') {
        queue.resume();
      } else if (type === 'parallel') {
        acc += item;
        if (acc === 1 + 2 + 3) {
          done();
        }
      }
    });

    queue.emit('parallel', 1);
    queue.emit('parallel', 2);
    queue.emit('parallel', 3);

    queue.emit('immediate', 1);
  });
});
