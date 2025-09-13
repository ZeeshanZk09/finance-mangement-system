'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools, ReactQueryDevtoolsPanel } from '@tanstack/react-query-devtools';
import Loading from '@/app/loading/page';
import { CustomTimeoutProvider } from './TimeoutProvider';

// ✅ Configure query client (with retry + cache settings as an example)
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      retryDelay: (attemptIndex) => {
        // Use your custom timeout strategy
        return Math.min(1000 * 2 ** attemptIndex, 30000);
      },
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60, // 1 minute
    },
  },
});

// ✅ Lazy load production Devtools
const ReactQueryDevtoolsProduction = React.lazy(() =>
  import('@tanstack/react-query-devtools/build/modern/production.js').then((mod) => ({
    default: mod.ReactQueryDevtools,
  }))
);

type AppProviderProps = {
  children: React.ReactNode;
};

export default function AppProvider({ children }: AppProviderProps) {
  const [showDevtools, setShowDevtools] = React.useState(false);

  // ✅ Allow toggling devtools from console
  React.useEffect(() => {
    // @ts-expect-error: Expose devtools toggle globally for debugging
    window.toggleDevtools = () => setShowDevtools((prev) => !prev);

    return () => {
      // Cleanup when unmounted
      // @ts-expect-error
      delete window.toggleDevtools;
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {children}

      {/* Devtools toggle button */}
      <button
        type='button'
        onClick={() => setShowDevtools((prev) => !prev)}
        className='fixed bottom-4 right-4 z-50 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-md transition hover:bg-blue-700'
      >
        {showDevtools ? 'Close Devtools' : 'Open Devtools'}
      </button>

      {/* Inline panel */}
      {showDevtools && <ReactQueryDevtoolsPanel onClose={() => setShowDevtools(false)} />}

      {/* Production Devtools */}
      {showDevtools && (
        <React.Suspense fallback={<Loading />}>
          <ReactQueryDevtoolsProduction />
        </React.Suspense>
      )}
    </QueryClientProvider>
  );
}
