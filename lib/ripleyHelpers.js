'use strict';

/**
 * Compute a list of steps where all actions with the same commitId are
 * never splitted. It uses by ripleyClient, Cryo and the SQLite transactions.
 * In one transaction, all same commitId must be there. It means that a step
 * (a loop) can have more than 100 actions and even less.
 *
 * For example, if the limit is 4 actions by iterate:
 * commitId
 *  A
 *  B
 *  D
 *  D
 *  D ... step 1, with 5 actions
 *  E
 *  F
 *  F
 *  G ... step 2, with 4 actions
 *
 * In this example, the first step will use 5 actions because the last action
 * with the commitId D cannot be in the second iteration.
 * @param {*} persisted
 * @param {*} commitCnt
 * @param {*} [limit]
 * @returns
 */
function computeRipleySteps(persisted, commitCnt, limit = 100) {
  let steps = [];

  /* Compute all intermediate steps for the main loop */
  const counted = {};
  let step = 0;
  for (const {data} of persisted) {
    const {commitId} = data;
    if (!counted[commitId]) {
      counted[commitId] = 0;
    }
    ++counted[commitId];
    if (counted[commitId] === commitCnt[commitId]) {
      if (commitCnt[commitId] > limit) {
        steps.push(step);
        step = commitCnt[commitId];
      } else {
        step += commitCnt[commitId];
      }
    }
    if (step >= limit) {
      steps.push(step);
      step = 0;
    }
  }
  if (step > 0) {
    steps.push(step);
    step = 0;
  }

  return steps;
}

module.exports = {
  computeRipleySteps,
};