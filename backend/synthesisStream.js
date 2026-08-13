const PRIVATE_TAIL_MARKERS = ["```json", "``` json", "【结构化 json"];
const HOLD_BACK_CHARS = Math.max(...PRIVATE_TAIL_MARKERS.map((marker) => marker.length)) - 1;

/**
 * Streams only user-visible markdown. The structured JSON footer is held back,
 * while finish() always reconciles the UI with the already validated final text.
 */
export function createSynthesisStreamEmitter(send) {
  let pending = "";
  let visible = "";
  let stopped = false;
  let emitted = false;

  const emit = (text) => {
    if (!text) return;
    visible += text;
    emitted = true;
    send("synthesis_token", { token: text });
  };

  return {
    push(delta) {
      if (stopped) return;
      pending += String(delta ?? "");
      const comparable = pending.toLowerCase();
      let markerIndex = -1;
      for (const marker of PRIVATE_TAIL_MARKERS) {
        const index = comparable.indexOf(marker);
        if (index >= 0 && (markerIndex < 0 || index < markerIndex)) markerIndex = index;
      }
      if (markerIndex >= 0) {
        emit(pending.slice(0, markerIndex));
        pending = "";
        stopped = true;
        return;
      }
      if (pending.length > HOLD_BACK_CHARS) {
        const flushLength = pending.length - HOLD_BACK_CHARS;
        emit(pending.slice(0, flushLength));
        pending = pending.slice(flushLength);
      }
    },

    finish(finalMarkdown) {
      const finalText = String(finalMarkdown ?? "");
      if (!stopped) {
        emit(pending);
        pending = "";
      }
      if (emitted) {
        if (visible !== finalText) send("synthesis_replace", { synthesis: finalText });
      } else if (finalText) {
        emit(finalText);
      }
      return emitted;
    },

    hasEmitted() {
      return emitted;
    },
  };
}
