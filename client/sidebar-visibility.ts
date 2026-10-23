/** Own one sidebar registration; late reads cannot register after teardown. */
export function sidebarVisibility(register: () => (() => void) | void) {
  let disposed = false;
  let remove: (() => void) | undefined;
  return {
    set(visible: boolean) {
      if (disposed) return;
      if (visible && !remove) remove = register() ?? (() => {});
      if (!visible && remove) {
        remove();
        remove = undefined;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      remove?.();
      remove = undefined;
    },
  };
}
