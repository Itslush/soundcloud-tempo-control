import moduleSource from 'tempo:preserve-worklet';
import { createPreserveOutput } from './preserve-output.mjs';

export function createBundledPreserveOutput(options) {
  return createPreserveOutput({ ...options, moduleSource });
}
