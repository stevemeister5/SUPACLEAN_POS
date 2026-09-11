import React, { useEffect, useState } from 'react';
import './InstallPrompt.css';

/**
 * PWA install-prompt capture: listens for beforeinstallprompt and shows a
 * small dismissible "Install SUPACLEAN POS" action. Hidden permanently for
 * the session after dismiss or install. Standalone-display browsers that
 * already run installed never show it (matchesPWA display-mode).
 */
export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [dismissed, setDismissed] = useState(
    () => window.sessionStorage.getItem('pwaInstallDismissed') === '1'
  );

  useEffect(() => {
    // Already installed (running standalone) - never show.
    if (window.matchMedia('(display-mode: standalone)').matches) return;

    const onPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    const onInstalled = () => {
      setDeferredPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!deferredPrompt || dismissed) return null;

  const handleInstall = async () => {
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } catch {
      /* choice errors are non-actionable */
    }
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    setDismissed(true);
    window.sessionStorage.setItem('pwaInstallDismissed', '1');
  };

  return (
    <div className="install-prompt" role="dialog" aria-label="Install app">
      <span className="install-prompt__text">Install SUPACLEAN POS for offline use</span>
      <button type="button" className="install-prompt__install" onClick={handleInstall}>
        Install
      </button>
      <button
        type="button"
        className="install-prompt__close"
        onClick={handleDismiss}
        aria-label="Dismiss install prompt"
      >
        ×
      </button>
    </div>
  );
}
