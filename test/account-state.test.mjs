import assert from 'node:assert/strict';
import test from 'node:test';
import { resetAccountState } from '../public/state/account-state.js';

test('account reset removes all user-owned renderer state', () => {
  const state = {
    user:{ id:'account-a' }, route:'drama', tasks:[{ id:'task-a' }], generationPreparations:[{ id:'prep-a' }],
    generationTab:'history', generationHistory:{ image:{ items:[{ id:'history-a' }] }, video:{ items:[] } },
    files:[{ id:'file-a' }], credits:42, creditTransactions:[{ id:'credit-a' }], creditWallet:{ balance:42, held:2, available:40 },
    alipayOrderNo:'order-a', notifications:[{ id:'notice-a' }], unreadNotifications:1, pricing:{ image:9 }, modelQuote:{ id:'quote-a' },
    config:{ account:'a' }, dramaAnalysis:{ id:'analysis-a' }, dramaProject:{ id:'project-a' }, dramaLoading:true, initialSyncReady:true,
    refs:{ image:['file-a'], video:['file-a'] }, imagePromptMentions:['file-a'], videoPromptMentions:['file-a'], videoFrames:{ first:'file-a', last:'file-a' },
    videoFrameTarget:'file-a', dialogSelection:['file-a'], uploadJobs:[{ id:'upload-a' }], detailTaskId:'task-a', previewFileId:'file-a',
  };
  resetAccountState(state);
  assert.equal(state.user, null);
  assert.equal(state.route, 'image');
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.generationHistory.image.items, []);
  assert.deepEqual(state.files, []);
  assert.equal(state.credits, 0);
  assert.deepEqual(state.creditTransactions, []);
  assert.deepEqual(state.notifications, []);
  assert.equal(state.unreadNotifications, 0);
  assert.equal(state.dramaProject, null);
  assert.deepEqual(state.refs, { image:[], video:[] });
  assert.deepEqual(state.videoFrames, { first:'', last:'' });
  assert.deepEqual(state.uploadJobs, []);
});
