'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className='flex min-h-screen flex-col items-center justify-center bg-red-50 px-4 text-center'>
      <h2 className='text-2xl font-semibold text-red-600'>Something went wrong!</h2>
      <p className='mt-2 text-gray-700'>{error.message || 'An unexpected error occurred.'}</p>
      <button
        onClick={() => reset()}
        className='mt-4 rounded-xl bg-red-600 px-6 py-2 text-white shadow-md transition hover:bg-red-700'
      >
        Try again
      </button>
    </div>
  );
}
