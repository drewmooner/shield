'use client';

import { Component, ReactNode, useEffect } from 'react';

function ExtensionErrorSuppressor({ children }: { children: ReactNode }) {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      if (
        event.message?.includes('MetaMask') ||
        event.filename?.includes('chrome-extension') ||
        event.filename?.includes('moz-extension')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
      }
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason?.message || event.reason?.toString() || '';
      if (
        reason.includes('MetaMask') ||
        reason.includes('chrome-extension') ||
        reason.includes('moz-extension')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener('error', handleError, true);
    window.addEventListener('unhandledrejection', handleRejection, true);

    return () => {
      window.removeEventListener('error', handleError, true);
      window.removeEventListener('unhandledrejection', handleRejection, true);
    };
  }, []);

  return <>{children}</>;
}

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: false };
  }

  componentDidCatch(error: Error) {
    if (
      error.message?.includes('MetaMask') ||
      error.stack?.includes('chrome-extension') ||
      error.stack?.includes('moz-extension')
    ) {
      return;
    }
    console.error('App error:', error);
  }

  render() {
    return (
      <ExtensionErrorSuppressor>
        {this.props.children}
      </ExtensionErrorSuppressor>
    );
  }
}
