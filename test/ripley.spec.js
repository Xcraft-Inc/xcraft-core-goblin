'use strict';

const {expect} = require('chai');

describe('xcraft.goblin.elf.ripley', function () {
  const {computeRipleySteps} = require('../lib/ripleySync.js');

  function checkStepSum(persisted, commitCnt, limit) {
    const steps = computeRipleySteps(persisted, commitCnt, limit);
    const sum = steps.reduce((acc, s) => acc + s, 0);
    expect(sum).to.equal(
      persisted.length,
      `steps sum ${sum} !== persisted.length ${persisted.length} (limit=${limit})`
    );
    return steps;
  }

  function checkNoSplitCommit(persisted, commitCnt, limit) {
    const steps = computeRipleySteps(persisted, commitCnt, limit);
    let pos = 0;
    for (const step of steps) {
      const chunk = persisted.slice(pos, pos + step);
      const commitIds = chunk.map((p) => p.data.commitId);

      /* The last commitId of the chunk must not appears in the next chunk */
      const lastId = commitIds.at(-1);
      const next = persisted.slice(pos + step, pos + step + 1);
      if (next.length) {
        expect(next[0].data.commitId).to.not.equal(
          lastId,
          `commitId "${lastId}" was split across steps at limit=${limit}`
        );
      }

      pos += step;
    }
  }

  //////////////////////////////////////////////////////////////////////////////

  const persisted8 = [
    {data: {commitId: 'A'}},
    {data: {commitId: 'B'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'E'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'G'}},
  ];

  const commitCnt8 = {
    A: 1,
    B: 1,
    D: 3,
    E: 1,
    F: 1,
    G: 1,
  };

  it('computeSteps 8 (old server)', function () {
    const steps = computeRipleySteps(persisted8, undefined, 4);
    expect(steps).to.be.eql([8]);
  });

  it('computeSteps 8 (new server, limit 1)', function () {
    const steps = computeRipleySteps(persisted8, commitCnt8, 1);
    expect(steps).to.be.eql([1, 1, 3, 1, 1, 1]);
  });

  it('computeSteps 8 (new server, limit 2)', function () {
    const steps = computeRipleySteps(persisted8, commitCnt8, 2);
    expect(steps).to.be.eql([2, 3, 2, 1]);
  });

  it('computeSteps 8 (new server, limit 4)', function () {
    const steps = computeRipleySteps(persisted8, commitCnt8, 4);
    expect(steps).to.be.eql([2, 4, 2]);
  });

  it('computeSteps 8 (new server, limit 6)', function () {
    const steps = computeRipleySteps(persisted8, commitCnt8, 6);
    expect(steps).to.be.eql([6, 2]);
  });

  it('computeSteps 8 (new server, limit 10)', function () {
    const steps = computeRipleySteps(persisted8, commitCnt8, 10);
    expect(steps).to.be.eql([8]);
  });

  it('computeSteps sum invariant holds for persisted8', function () {
    for (const limit of [1, 2, 3, 4, 5, 6, 10, 20, 100]) {
      checkStepSum(persisted8, commitCnt8, limit);
    }
  });

  it('computeSteps no commitId split for persisted8', function () {
    for (const limit of [1, 2, 3, 4, 5, 6, 10, 20]) {
      checkNoSplitCommit(persisted8, commitCnt8, limit);
    }
  });

  //////////////////////////////////////////////////////////////////////////////

  const persisted22 = [
    {data: {commitId: 'A'}},
    {data: {commitId: 'A'}},
    {data: {commitId: 'B'}},
    {data: {commitId: 'C'}},
    {data: {commitId: 'C'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'E'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'G'}},
    {data: {commitId: 'G'}},
    {data: {commitId: 'G'}},
    {data: {commitId: 'H'}},
    {data: {commitId: 'I'}},
    {data: {commitId: 'I'}},
    {data: {commitId: 'I'}},
  ];

  const commitCnt22 = {
    A: 2,
    B: 1,
    C: 2,
    D: 3,
    E: 1,
    F: 6,
    G: 3,
    H: 1,
    I: 3,
  };

  it('computeSteps 22 (old server)', function () {
    const steps = computeRipleySteps(persisted22, undefined, 4);
    expect(steps).to.be.eql([22]);
  });

  it('computeSteps 22 (new server, limit 1)', function () {
    const steps = computeRipleySteps(persisted22, commitCnt22, 1);
    expect(steps).to.be.eql([2, 1, 2, 3, 1, 6, 3, 1, 3]);
  });

  it('computeSteps 22 (new server, limit 2)', function () {
    const steps = computeRipleySteps(persisted22, commitCnt22, 2);
    expect(steps).to.be.eql([2, 1, 2, 3, 1, 6, 3, 1, 3]);
  });

  it('computeSteps 22 (new server, limit 4)', function () {
    const steps = computeRipleySteps(persisted22, commitCnt22, 4);
    expect(steps).to.be.eql([3, 2, 4, 6, 4, 3]);
  });

  it('computeSteps 22 (new server, limit 6)', function () {
    const steps = computeRipleySteps(persisted22, commitCnt22, 6);
    expect(steps).to.be.eql([5, 4, 6, 4, 3]);
  });

  it('computeSteps 22 (new server, limit 10)', function () {
    const steps = computeRipleySteps(persisted22, commitCnt22, 10);
    expect(steps).to.be.eql([9, 10, 3]);
  });

  it('computeSteps sum invariant holds for persisted22', function () {
    for (const limit of [1, 2, 3, 4, 5, 6, 10, 20, 100]) {
      checkStepSum(persisted22, commitCnt22, limit);
    }
  });

  it('computeSteps no commitId split for persisted22', function () {
    for (const limit of [1, 2, 3, 4, 5, 6, 10, 20]) {
      checkNoSplitCommit(persisted22, commitCnt22, limit);
    }
  });

  //////////////////////////////////////////////////////////////////////////////

  it('computeSteps empty persisted', function () {
    const steps = computeRipleySteps([], {}, 4);
    expect(steps).to.be.eql([]);
  });

  it('computeSteps single action', function () {
    const steps = computeRipleySteps([{data: {commitId: 'A'}}], {A: 1}, 4);
    expect(steps).to.be.eql([1]);
  });

  it('computeSteps commitId larger than limit stays in one step', function () {
    const persisted = Array.from({length: 25}, () => ({
      data: {commitId: 'BIG'},
    }));
    const commitCnt = {BIG: 25};

    const steps = computeRipleySteps(persisted, commitCnt, 10);
    expect(steps).to.be.eql([25]); /* No slices */
    checkNoSplitCommit(persisted, commitCnt, 10);
  });
});
