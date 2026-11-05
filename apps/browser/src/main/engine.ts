import { app } from 'electron';
import type { EngineReport } from '../shared/types';

/**
 * Chromium features that put AI models or AI services behind web APIs. Electron has no //chrome
 * layer (no Gemini Nano, no optimization-guide model downloads, no "Help me write"), but Blink
 * still exposes the built-in AI APIs; these switches remove them from every page and worker.
 */
export const DISABLED_FEATURES = [
  'AIPromptAPI',
  'AIPromptAPIForWorkers',
  'AIPromptAPIMultimodalInput',
  'AIPromptAPIToolUse',
  'AIPromptAPIStructuredOutput',
  'AISummarizationAPI',
  'AISummarizationAPIForWorkers',
  'AIWriterAPI',
  'AIWriterAPIForWorkers',
  'AIRewriterAPI',
  'AIRewriterAPIForWorkers',
  'AIProofreaderAPI',
  'AIProofreadingAPI',
  'AIClassifierAPI',
  'AIEmbeddingsAPI',
  'AIEmbeddingsAPIForWorkers',
  'TranslationAPI',
  'LanguageDetectionAPI',
  'WebMachineLearningNeuralNetwork',
  'ExperimentalWebMachineLearningNeuralNetwork',
  'InstallOnDeviceSpeechRecognition',
  'OnDeviceSpeechRecognitionEngine',
  'AIPageContentAgent',
];

export const DISABLED_BLINK_FEATURES = [
  'AIPromptAPI',
  'AISummarizationAPI',
  'AIWriterAPI',
  'AIRewriterAPI',
  'AIProofreaderAPI',
  'AIProofreadingAPI',
  'AIClassifierAPI',
  'AIEmbeddingsAPI',
  'TranslationAPI',
  'LanguageDetectionAPI',
  'ScriptedSpeechRecognition',
  'UnprefixedSpeechRecognition',
  'WebMachineLearningNeuralNetwork',
  'HandwritingRecognition',
];

/** Globals that must not exist in any page; checked by the engine purity tests. */
export const FORBIDDEN_GLOBALS = [
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
];

export function applyEngineSwitches(): void {
  app.commandLine.appendSwitch('disable-features', DISABLED_FEATURES.join(','));
  app.commandLine.appendSwitch('disable-blink-features', DISABLED_BLINK_FEATURES.join(','));
  // No Chrome-style background networking, metrics or field trials exist in Electron; keep it so.
  app.commandLine.appendSwitch('disable-domain-reliability');
}

export function engineReport(): EngineReport {
  return { disabledFeatures: DISABLED_FEATURES, disabledBlinkFeatures: DISABLED_BLINK_FEATURES };
}

/** Plain Chrome UA (no Electron or app token) so sites treat us like any Chromium browser. */
export function chromeUserAgent(): string {
  const major = process.versions.chrome.split('.')[0];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
