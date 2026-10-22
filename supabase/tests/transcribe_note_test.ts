import {
  extractTranscript,
  MAX_AUDIO_BYTES,
  normalizedAudioType,
  validateAudioFile,
} from "../functions/transcribe-note/core.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("normalizes supported recording MIME types", () => {
  assertEquals(normalizedAudioType("audio/webm;codecs=opus"), "audio/webm");
  assertEquals(normalizedAudioType(" AUDIO/MP4 "), "audio/mp4");
});

Deno.test("accepts a bounded supported audio file", () => {
  const file = new File([new Uint8Array([1, 2, 3])], "note.webm", {
    type: "audio/webm;codecs=opus",
  });
  const result = validateAudioFile(file);
  assert(result.ok);
  assertEquals(result.value.size, 3);
});

Deno.test("rejects missing, empty, unsupported, and oversized audio", () => {
  assertEquals(validateAudioFile(null), { ok: false, error: "audio file is required" });
  assertEquals(
    validateAudioFile(new File([], "empty.webm", { type: "audio/webm" })),
    { ok: false, error: "audio file is empty" },
  );
  assertEquals(
    validateAudioFile(new File(["x"], "note.aac", { type: "audio/aac" })),
    { ok: false, error: "audio file type is not supported" },
  );
  const oversized = new File([new Uint8Array(MAX_AUDIO_BYTES + 1)], "large.webm", {
    type: "audio/webm",
  });
  assertEquals(validateAudioFile(oversized), { ok: false, error: "audio file is too large" });
});

Deno.test("extracts and bounds a provider transcript", () => {
  assertEquals(extractTranscript({ text: "  Met Anna.\nSend the deck. " }), {
    ok: true,
    value: "Met Anna. Send the deck.",
  });
  assertEquals(extractTranscript({}), { ok: false, error: "provider response is missing text" });
  assertEquals(extractTranscript({ text: "   " }), {
    ok: false,
    error: "provider transcript is empty",
  });
  assertEquals(
    extractTranscript({ text: "x".repeat(6001) }),
    { ok: false, error: "provider transcript is too long" },
  );
});
