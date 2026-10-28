// Voice input through the browser's Web Speech API (Chrome and Edge; Firefox has
// none). No dependency: the browser does the recognition, which means it needs an
// internet connection -- Chrome and Edge send the audio to their speech services.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// The Web Speech API is not in TypeScript's DOM lib, so only what we use is typed here.
interface RecognitionResultEvent {
  results: ArrayLike<{ isFinal: boolean; [alternative: number]: { transcript: string } }>;
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const subscribeNever = () => () => {};

function describeError(code: string): string | null {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow the microphone for this site in the browser, then try again.";
    case "no-speech":
      return "Didn't hear anything. Tap the mic and speak your request.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Voice input needs an internet connection: the browser sends the audio to its speech service.";
    default:
      return `Voice input stopped (${code}). Type the request instead.`;
  }
}

/**
 * onTranscript gets the text heard so far on every update, with isFinal true
 * once the browser has settled on what was said.
 */
export function useSpeechRecognition(onTranscript: (text: string, isFinal: boolean) => void) {
  const supported = useSyncExternalStore(subscribeNever, () => recognitionConstructor() !== null, () => false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<Recognition | null>(null);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  });

  useEffect(() => () => recognitionRef.current?.abort(), []);

  const start = useCallback(() => {
    const Constructor = recognitionConstructor();
    if (!Constructor || recognitionRef.current) return;

    const recognition = new Constructor();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      const last = event.results[event.results.length - 1];
      onTranscriptRef.current(text.trim(), Boolean(last?.isFinal));
    };
    recognition.onerror = (event) => setError(describeError(event.error));
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };

    recognitionRef.current = recognition;
    setError(null);
    setListening(true);
    recognition.start();
  }, []);

  const stop = useCallback(() => recognitionRef.current?.stop(), []);

  return { supported, listening, error, start, stop };
}
