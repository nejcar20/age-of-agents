import { writeClipboardText } from "./agents";

/** Only the pane's output may become an automatic clipboard write. */
export function selectedOutputText(output: HTMLElement | null): string {
  const selection = window.getSelection();
  if (!output || !selection || selection.isCollapsed || !selection.rangeCount) return "";
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (!output.contains(range.startContainer) || !output.contains(range.endContainer)) return "";
  }
  return selection.toString();
}

/** A completed user selection, never a global selectionchange, owns copy.
 * The deferred read lets xterm finish its document-level mouseup handler. */
export function copyCompletedSelection({ host, enabled, getText, onError }: {
  host: HTMLElement;
  enabled: () => boolean;
  getText: () => string;
  onError: (message: string | null) => void;
}): () => void {
  let selecting = false;
  let stopped = false;
  let timer = 0;
  const finish = () => {
    if (!selecting) return;
    selecting = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (stopped || !enabled()) return;
      const text = getText();
      if (!text) return;
      void writeClipboardText(text).then(() => {
        if (!stopped) onError(null);
      }).catch(reason => {
        if (!stopped) onError(`Clipboard copy failed: ${String(reason)}`);
      });
    }, 0);
  };
  const begin = (event: MouseEvent) => {
    window.clearTimeout(timer);
    // A mousedown also activates an inactive split in React's parent
    // handler. Read the active state when the selection finishes.
    selecting = event.button === 0 && !(event.target instanceof Element && event.target.closest('input, textarea, select, button, [contenteditable="true"]'));
  };
  const keyup = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === "a" && event.metaKey && !event.ctrlKey && !event.altKey) {
      selecting = enabled();
      finish();
    }
  };
  host.addEventListener("mousedown", begin);
  host.addEventListener("keyup", keyup);
  document.addEventListener("mouseup", finish);
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    host.removeEventListener("mousedown", begin);
    host.removeEventListener("keyup", keyup);
    document.removeEventListener("mouseup", finish);
  };
}
