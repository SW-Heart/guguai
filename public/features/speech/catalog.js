import { minimaxSystemVoices } from './system-voices.js?v=1';
export const speechModels=[
  {id:'speech-2.8-hd',label:'MiniMax Speech 2.8 HD',creditsPerTenThousand:35},
  {id:'speech-2.8-turbo',label:'MiniMax Speech 2.8 Turbo',creditsPerTenThousand:20},
];
export const speechDesignModel={id:'minimax-voice-design',label:'MiniMax 音色设计',creditsPerVoice:99};
export const speechPreviewModel={id:'minimax-voice-preview',label:'MiniMax 音色设计试听',creditsPerTenThousand:20};
export const speechEmotions={auto:'自动',happy:'开心',sad:'悲伤',angry:'愤怒',fearful:'恐惧',disgusted:'厌恶',surprised:'惊讶',neutral:'平静'};
export function speechCharacters(text){return Array.from(String(text||'')).reduce((count,char)=>count+(/\p{Script=Han}/u.test(char)?2:1),0);}
export const systemVoices=minimaxSystemVoices;
