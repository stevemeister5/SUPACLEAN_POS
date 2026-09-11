import { useEffect, useCallback } from 'react';

/**
 * Global keyboard shortcuts for the POS system.
 * Optimized for speed of operation.
 *
 * Shortcuts:
 *   Ctrl+N     → New order (navigate to /new-order)
 *   Ctrl+K     → Focus search (customer/receipt search)
 *   Ctrl+Enter → Submit/confirm (context-dependent)
 *   Ctrl+P     → Print receipt
 *   Escape     → Close modal / Clear search
 *   1-9        → Quick-add favorite item (on New Order page)
 */

export function useKeyboardShortcuts({ onNewOrder, onFocusSearch, onSubmit, onPrint, onEscape, onQuickAdd } = {}) {
  const handleKeyDown = useCallback((e) => {
    // Don't trigger shortcuts when typing in inputs (except Enter/Escape)
    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
    const isModifier = e.ctrlKey || e.metaKey;

    // Ctrl+K or Cmd+K → Focus search
    if (isModifier && e.key === 'k') {
      e.preventDefault();
      onFocusSearch?.();
      return;
    }

    // Ctrl+N or Cmd+N → New order
    if (isModifier && e.key === 'n') {
      e.preventDefault();
      onNewOrder?.();
      return;
    }

    // Ctrl+Enter → Submit
    if (isModifier && e.key === 'Enter') {
      e.preventDefault();
      onSubmit?.();
      return;
    }

    // Ctrl+P → Print
    if (isModifier && e.key === 'p') {
      e.preventDefault();
      onPrint?.();
      return;
    }

    // Escape → Close/Clear
    if (e.key === 'Escape' && !isModifier) {
      onEscape?.();
      return;
    }

    // Quick-add: 1-9 (only on New Order page, not in inputs)
    if (!isInput && !isModifier && /^[1-9]$/.test(e.key)) {
      const index = parseInt(e.key, 10) - 1;
      onQuickAdd?.(index);
      return;
    }
  }, [onNewOrder, onFocusSearch, onSubmit, onPrint, onEscape, onQuickAdd]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

export default useKeyboardShortcuts;
