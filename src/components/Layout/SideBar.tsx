'use client';

import React, { useState } from 'react';

type Tab = {
  id: string;
  title: string;
  subtitle?: string;
  content: React.ReactNode;
};

export default function SideBar() {
  const tabs: Tab[] = [
    {
      id: 'overview',
      title: 'Overview',
      subtitle: 'Quick summary',
      content: (
        <div>
          <h2 className='text-2xl font-semibold mb-2'>Overview</h2>
          <p className='text-sm leading-relaxed'>
            This is the overview content. Show KPIs, recent activity or a dashboard-like summary
            here. You can replace this with any JSX — tables, charts, forms, etc.
          </p>
        </div>
      ),
    },
    {
      id: 'invoices',
      title: 'Invoices',
      subtitle: 'Create & manage',
      content: (
        <div>
          <h2 className='text-2xl font-semibold mb-2'>Invoices</h2>
          <ul className='list-disc pl-5 text-sm leading-relaxed'>
            <li>Invoice #1001 — Paid</li>
            <li>Invoice #1002 — Due</li>
            <li>Create a new invoice using the + button.</li>
          </ul>
        </div>
      ),
    },
    {
      id: 'customers',
      title: 'Customers',
      subtitle: 'Manage contacts',
      content: (
        <div>
          <h2 className='text-2xl font-semibold mb-2'>Customers</h2>
          <p className='text-sm leading-relaxed'>List of customers goes here.</p>
        </div>
      ),
    },
    {
      id: 'settings',
      title: 'Settings',
      subtitle: 'Preferences',
      content: (
        <div>
          <h2 className='text-2xl font-semibold mb-2'>Settings</h2>
          <p className='text-sm leading-relaxed'>App preferences & options.</p>
        </div>
      ),
    },
  ];

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string>(tabs[0].id);

  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <section
      className={`relative overflow-hidden text-black col-span-1 p-4 transform transition-all ease-in-out hover:translate-x-0 flex justify-center items-center min-h-screen w-screen duration-300 ${
        open
          ? 'translate-x-0 opacity-100 pointer-events-auto'
          : '-translate-x-full hidden opacity-0 pointer-events-none'
      } backdrop-blur-xs bg-[#5e5d5d] `}
      onClick={() => setOpen(!open)}
    >
      {/* Sidebar panel */}
      <aside
        className={`absolute z-50 grid rounded-full transform transition-transform duration-300 ease-in-out `}
        role='dialog'
        aria-modal='true'
        aria-hidden={!open}
      >
        <div className='flex h-full  bg-[#000000ad] rounded-lg backdrop-blur-sm shadow-xl'>
          {/* Left: Main content (bigger) */}
          <div className='p-6 overflow-auto'>
            <div className='rounded-xl bg-[#5c5b5b36] p-6 h-full shadow-inner'>
              {/* Simple transition between tab contents using CSS */}
              <div key={active} className='transition-all duration-300 ease-in-out'>
                {activeTab.content}
              </div>
            </div>
          </div>

          {/* Right: Vertical buttons */}
          <div className='border-l border-gray-200 p-4 flex flex-col gap-3 items-stretch'>
            <div className='flex items-center justify-between px-2'>
              <h3 className='text-sm font-medium'>Sections</h3>
              <button
                onClick={() => setOpen(false)}
                aria-label='Close sidebar'
                className='text-sm p-1 rounded hover:bg-gray-100'
              >
                Close
              </button>
            </div>

            <nav className='mt-2 flex flex-col gap-2' aria-label='Sidebar tabs'>
              {tabs.map((tab) => {
                const isActive = tab.id === active;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActive(tab.id)}
                    className={`flex items-start gap-3 rounded-lg p-3 text-left transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-cyan-400 ${
                      isActive ? 'bg-cyan-600 text-white' : 'bg-white'
                    }`}
                    aria-current={isActive ? 'true' : undefined}
                  >
                    <div className='flex-shrink-0'>
                      {/* simple icon placeholder */}
                      <div
                        className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold ${
                          isActive ? 'bg-white text-cyan-600' : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {tab.title.charAt(0)}
                      </div>
                    </div>
                    <div className='flex-1'>
                      <div className='text-sm font-semibold'>{tab.title}</div>
                      {tab.subtitle && (
                        <div className={`text-xs ${isActive ? 'text-cyan-100' : 'text-gray-500'}`}>
                          {tab.subtitle}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </nav>

            <div className='mt-auto'>
              {/* footer area for extra actions */}
              <button className='w-full rounded-md border border-gray-200 px-4 py-2 text-sm hover:bg-gray-50'>
                More actions
              </button>
            </div>
          </div>
        </div>
      </aside>
    </section>
  );
}
