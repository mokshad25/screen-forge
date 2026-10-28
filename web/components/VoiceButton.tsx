interface VoiceButtonProps {
  supported: boolean;
  listening: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function VoiceButton({ supported, listening, onStart, onStop }: VoiceButtonProps) {
  let label = "Speak your request";
  if (!supported) label = "Voice input needs Chrome or Edge";
  else if (listening) label = "Stop listening";

  return (
    <button
      type="button"
      onClick={listening ? onStop : onStart}
      disabled={!supported}
      aria-pressed={listening}
      aria-label={label}
      title={label}
      className={`relative grid size-11 shrink-0 place-items-center rounded-lg border disabled:cursor-not-allowed disabled:opacity-40 ${
        listening ? "border-neutral-fill bg-neutral-fill text-bezel" : "border-cell-border bg-bg text-text hover:border-neutral-fill"
      }`}
    >
      <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <path d="M12 18v3" />
      </svg>
      {listening && <span aria-hidden className="sf-pulse absolute right-1 top-1 size-2 rounded-full bg-bezel" />}
    </button>
  );
}
