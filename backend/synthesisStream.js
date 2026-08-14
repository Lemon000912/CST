const PRIVATE_TAIL_MARKERS = ["```json", "``` json", "【结构化 json"];
const HOLD_BACK_CHARS = Math.max(...PRIVATE_TAIL_MARKERS.map((marker) => marker.length)) - 1;

/**
 * Streams only user-visible markdown. The structured JSON footer is held back,
 * while finish() always reconciles the UI with the already validated final text.
 */
export function createSynthesisStreamEmitter(send, options = {}) {
  let pending = "";
  let visible = "";
  let stopped = false;
  let emitted = false;
  let limitReached = false;
  const rawLimit = Number(options.maxVisibleCodePoints);
  const maxVisibleCodePoints = Number.isSafeInteger(rawLimit) && rawLimit >= 0
    ? rawLimit
    : Number.POSITIVE_INFINITY;
  let visibleCodePoints = 0;

  const reachLimit = () => {
    if (limitReached) return;
    limitReached = true;
    options.onLimitReached?.();
  };

  const emit = (text) => {
    if (!text) return;
    const codePoints = Array.from(String(text));
    const remaining = Math.max(0, maxVisibleCodePoints - visibleCodePoints);
    const accepted = codePoints.slice(0, remaining).join("");
    if (accepted) {
      visible += accepted;
      visibleCodePoints += Math.min(codePoints.length, remaining);
      emitted = true;
      send("synthesis_token", { token: accepted });
    }
    if (codePoints.length > remaining || visibleCodePoints >= maxVisibleCodePoints) {
      reachLimit();
    }
  };

  return {
    push(delta) {
      if (stopped || limitReached) return;
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
      if (!stopped && !limitReached) {
        emit(pending);
        pending = "";
      }
      const limitedFinalText = Array.from(finalText).slice(0, maxVisibleCodePoints).join("");
      const reconciledText = limitedFinalText || (limitReached ? visible : "");
      if (emitted) {
        if (visible !== reconciledText) {
          visible = reconciledText;
          visibleCodePoints = Array.from(visible).length;
          send("synthesis_replace", { synthesis: visible });
        }
      } else if (reconciledText) {
        emit(reconciledText);
      }
      if (Array.from(finalText).length > maxVisibleCodePoints) reachLimit();
      return emitted;
    },

    hasEmitted() {
      return emitted;
    },

    getVisibleText() {
      return visible;
    },

    isLimitReached() {
      return limitReached;
    },
  };
}
