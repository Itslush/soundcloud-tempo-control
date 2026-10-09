import {
  ADTS,
  BufferSource,
  CustomPathedSource,
  EncodedPacketSink,
  HLS,
  Input,
  MP4,
  MPEG_TS,
} from 'mediabunny';

export const Mediabunny = Object.freeze({
  BufferSource,
  CustomPathedSource,
  EncodedPacketSink,
  // The buffered path accepts AAC-LC, not MP3 or QuickTime streams.
  HLS_FORMATS: Object.freeze([HLS, MP4, ADTS, MPEG_TS]),
  Input,
});
