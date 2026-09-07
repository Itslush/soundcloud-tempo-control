import createModule from '../../vendor/signalsmith/wasm-factory.mjs';
import { registerPreserveProcessor } from './preserve-worklet.mjs';

registerPreserveProcessor(createModule, 'soundcloud-preserve-buffered-v1');
