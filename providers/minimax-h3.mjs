export const MINIMAX_H3_TEXT_MODEL_ID = 'minimax_h3_z0901';

export function minimaxH3SubmitModel(task, configuredModel, hasImage) {
  const isMinimaxH3 = ['minimax-h3', 'minimax-h3-15s'].includes(task.videoModelId)
    || task.videoProfile?.startsWith('minimax-h3-')
    || ['minimax_h3_image_audio_to_video_v2_15s', 'minimax_h3_zm_u24', MINIMAX_H3_TEXT_MODEL_ID].includes(configuredModel);
  return isMinimaxH3 && !hasImage ? MINIMAX_H3_TEXT_MODEL_ID : configuredModel;
}
