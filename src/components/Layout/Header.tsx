import React from 'react';
import HeaderLinks from '../utils/HeaderLinks';

export default function Header() {
  return (
    <header className='fixed w-screen grid text-sm justify-between row-span-1 border-b p-4'>
      {/* panel 1 */}
      <div className='flex flex-col items-start space-y-4 '>
        <HeaderLinks />
        <button>Side Bar</button>
      </div>
    </header>
  );
}
