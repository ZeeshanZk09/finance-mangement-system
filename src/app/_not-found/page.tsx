import Link from 'next/link';

export default function NotFound() {
  return (
    <div className='flex min-h-screen flex-col items-center justify-center bg-gray-100 px-4 text-center'>
      <h2 className='text-4xl font-bold text-gray-800'>404</h2>
      <p className='mt-2 text-lg text-gray-600'>Page not found</p>
      <Link
        href='/'
        className='mt-4 rounded-xl bg-blue-600 px-6 py-2 text-white shadow-md transition hover:bg-blue-700'
      >
        Go back home
      </Link>
    </div>
  );
}
