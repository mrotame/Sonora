// Audio identity and decoding (ADR 0006, amended by ADR 0009).

export const CANONICAL_SAMPLE_RATE = 44_100;

export interface DecodedAudio {
  /** SHA-256 (hex) of the delivered file bytes: the audio identity. */
  identity: string;
  sampleRate: number;
  durationS: number;
  /** Two Float32 channels at 44,100 Hz, not interleaved. Mono is duplicated (same array twice). */
  channels: [Float32Array, Float32Array];
  /** The decoded buffer, kept for playback (its channel arrays are views of it). */
  buffer: AudioBuffer;
}

export class DecodeError extends Error {}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hashes the file, then decodes it. The hash is taken first because
 * decodeAudioData detaches the input buffer. Takes ownership of `file`.
 */
export async function decodeAudioFile(file: ArrayBuffer): Promise<DecodedAudio> {
  if (!globalThis.isSecureContext || !crypto.subtle) throw new DecodeError('crypto.subtle requires a secure context');

  const identity = toHex(await crypto.subtle.digest('SHA-256', file));

  let buffer: AudioBuffer;
  try {
    // The context only decodes (1 frame); decodeAudioData resamples to its sample rate.
    buffer = await new OfflineAudioContext(2, 1, CANONICAL_SAMPLE_RATE).decodeAudioData(file);
  } catch {
    throw new DecodeError('decodeAudioData failed');
  }
  if (buffer.sampleRate !== CANONICAL_SAMPLE_RATE || buffer.numberOfChannels < 1) {
    throw new DecodeError('unexpected decoded format');
  }

  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  return { identity, sampleRate: buffer.sampleRate, durationS: buffer.duration, channels: [left, right], buffer };
}
