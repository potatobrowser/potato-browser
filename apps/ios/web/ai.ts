/**
 * Globals of AI web APIs (and speech recognition) that must not exist in any page. A superset of
 * the Mac app's FORBIDDEN_GLOBALS (apps/browser/src/main/engine.ts); a unit test keeps it so.
 */
export const AI_GLOBALS = [
  'LanguageModel',
  'Summarizer',
  'Writer',
  'Rewriter',
  'Proofreader',
  'Translator',
  'LanguageDetector',
  'Classifier',
  'ai',
  'SpeechRecognition',
  'webkitSpeechRecognition',
  'SpeechRecognitionEvent',
  'webkitSpeechRecognitionEvent',
  'SpeechRecognitionErrorEvent',
  'SpeechGrammar',
  'webkitSpeechGrammar',
  'SpeechGrammarList',
  'webkitSpeechGrammarList',
  'SpeechRecognitionPhrase',
];

/** Navigator properties of AI APIs (WebNN). */
export const AI_NAVIGATOR_PROPS = ['ml'];
