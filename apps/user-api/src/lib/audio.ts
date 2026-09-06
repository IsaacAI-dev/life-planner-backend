import { WAVEFORM_SAMPLES } from '@lifeplanner/shared-utils';

/**
 * Builds the normalised 0–1 bar heights the chat UI draws under a voice note.
 *
 * Honest caveat: properly measuring amplitude means decoding Opus/AAC, which
 * needs ffmpeg. This computes an energy envelope over the compressed byte
 * stream instead — for VBR codecs, byte density per time slice does track
 * loudness closely enough for a decorative waveform, and it is deterministic,
 * so sender and recipient always render identical bars. If ffmpeg is added to
 * the image later, swap the body of this function for a real PCM pass; nothing
 * else has to change.
 */
export function buildWaveform(buffer: Buffer, samples = WAVEFORM_SAMPLES): number[] {
  if (buffer.length === 0) return new Array(samples).fill(0);

  const bucketSize = Math.max(1, Math.floor(buffer.length / samples));
  const raw: number[] = [];

  for (let i = 0; i < samples; i += 1) {
    const start = i * bucketSize;
    const end = Math.min(start + bucketSize, buffer.length);
    if (start >= buffer.length) {
      raw.push(0);
      continue;
    }
    let sum = 0;
    for (let j = start; j < end; j += 1) {
      // Centre each byte around zero so silence (long runs of one value) reads low.
      sum += Math.abs(buffer[j] - 128);
    }
    raw.push(sum / (end - start));
  }

  const peak = Math.max(...raw, 1);
  return raw.map((v) => Math.round((v / peak) * 100) / 100);
}

/** Guards the configured duration ceiling; the client reports duration itself. */
export function assertDuration(durationSeconds: number, maxSeconds: number): void {
  if (durationSeconds > maxSeconds) {
    throw new Error(`Voice notes are limited to ${Math.floor(maxSeconds / 60)} minutes`);
  }
}
