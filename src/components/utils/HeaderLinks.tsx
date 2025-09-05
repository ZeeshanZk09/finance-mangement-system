import Link from 'next/link';
import React from 'react';

export default function HeaderLinks() {
  const headerLinks = [
    { name: 'Dashboard', href: '/' },
    { name: 'Invoices', href: '/invoices' },
    { name: 'Vendors', href: '/vendors' },
    { name: 'Customers', href: '/customers' },
    { name: 'Reports', href: '/reports' },
  ];
  return (
    <ul>
      <li className='flex space-x-4'>
        {headerLinks.map((link) => (
          <Link
            key={link.name}
            href={link.href}
            className='rounded-md text-sm font-medium text-gray-200 hover:bg-gray-700'
          >
            {link.name}
          </Link>
        ))}
      </li>
    </ul>
  );
}
