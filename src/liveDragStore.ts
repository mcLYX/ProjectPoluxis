import { useSyncExternalStore } from 'react';

/**
 * Tiny external store for live editor-drag values. During a note drag the 3D/2D
 * canvases mutate the visual every frame but only commit to React `chart` state
 * on release (committing per-frame re-resolves the whole ~2000-note chart and
 * was the source of per-frame jank on Android). The editor side panel still needs
 * to show the *current* position in real time, so the canvas pushes the live
 * position here every frame. Only components that subscribe (the editor panel)
 * re-render — App and the heavy GameCanvas/Editor2DCanvas stay untouched because
 * GameCanvas is React.memo'd and this store is entirely outside the React tree.
 */
export interface LiveDragState {
  /** Note id being dragged. Slide children carry the "base#i" suffix. */
  id: string;
  x: number;
  y: number;
  /** Optional beat (the 2D editor drags beat too; 3D drag keeps it). */
  beat?: number;
}

let state: LiveDragState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export const liveDragStore = {
  getSnapshot: (): LiveDragState | null => state,
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  /** Update the live position. No-op when nothing changed so subscribers (and
   *  therefore React) are not notified for duplicate frames — during a drag the
   *  value is snapped to a grid step, so this naturally fires once per visible
   *  change rather than 60×/sec. */
  set: (next: LiveDragState): void => {
    if (
      state &&
      state.id === next.id &&
      state.x === next.x &&
      state.y === next.y &&
      state.beat === next.beat
    ) {
      return;
    }
    state = next;
    emit();
  },
  /** Drag finished/released — stop overriding the panel with live values so it
   *  reflects the now-committed authoritative chart state. */
  clear: (): void => {
    if (state === null) return;
    state = null;
    emit();
  },
};

/** Subscribe a component to live-drag values (re-renders only that component). */
export function useLiveDrag(): LiveDragState | null {
  return useSyncExternalStore(liveDragStore.subscribe, liveDragStore.getSnapshot);
}
