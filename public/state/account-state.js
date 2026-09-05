const emptyHistory = () => ({
  image:{ items:[], cursor:'', hasMore:true, loaded:false, loading:false, error:'' },
  video:{ items:[], cursor:'', hasMore:true, loaded:false, loading:false, error:'' },
});

export function resetAccountState(state) {
  Object.assign(state, {
    user:null,
    route:'image',
    tasks:[],
    generationPreparations:[],
    generationTab:'works',
    generationHistory:emptyHistory(),
    files:[],
    credits:0,
    creditTransactions:[],
    creditWallet:{ balance:0, held:0, available:0 },
    alipayOrderNo:'',
    notifications:[],
    unreadNotifications:0,
    pricing:{ image:1, videoPerSecond:1, signupBonus:50, yuanPerCredit:.1 },
    modelQuote:null,
    config:{},
    dramaAnalysis:null,
    dramaProject:null,
    dramaLoading:false,
    initialSyncReady:false,
    refs:{ image:[], video:[] },
    imagePromptMentions:[],
    videoPromptMentions:[],
    videoFrames:{ first:'', last:'' },
    videoFrameTarget:'',
    dialogSelection:[],
    uploadJobs:[],
    detailTaskId:null,
    previewFileId:null,
  });
  return state;
}
