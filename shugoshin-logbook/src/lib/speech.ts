/**
 * Web Speech API ラッパー（音声認識）
 */

type SpeechCallback = {
  onResult: (text: string) => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
};

/** lib.dom に型が無いため、使う範囲だけ定義する */
interface SpeechRecognitionEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface SpeechRecognitionErrorEvent {
  error: string;
}

let recognition: any = null;

export function isSpeechSupported(): boolean {
  return !!(
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition
  );
}

export function startListening({ onResult, onEnd, onError }: SpeechCallback) {
  const SpeechRecognitionCtor =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

  if (!SpeechRecognitionCtor) {
    onError?.("このブラウザは音声入力に対応していません");
    return;
  }

  recognition = new SpeechRecognitionCtor();
  recognition.lang = "ja-JP";
  recognition.interimResults = false;
  recognition.continuous = false;

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    const transcript = event.results[0]?.[0]?.transcript ?? "";
    onResult(transcript);
  };

  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    onError?.(event.error);
  };

  recognition.onend = () => {
    onEnd?.();
  };

  recognition.start();
}

export function stopListening() {
  recognition?.stop();
  recognition = null;
}
