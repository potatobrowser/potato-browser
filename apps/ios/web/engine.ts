/** JavaScriptCore entry: polyfills first, then the engine API as `PotatoEngine`. */
import './jsc-polyfills';
import { createEngineApi } from './engine-api';

(globalThis as Record<string, unknown>).PotatoEngine = createEngineApi();
