import React from 'react';
import Header from './Header';
import SideBar from './SideBar';
import Footer from './Footer';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <section className='overflow-hidden grid min-h-screen grid-cols-1 grid-rows-layout'>
      {/* top header */}
      <Header />
      {/* left side sidebar */}
      <SideBar />
      {/* main content */}
      <main className='col-span-1 mx-auto min-h-screen py-40'>{children}</main>
      {/* bottom footer */}
      <Footer />
    </section>
  );
}
